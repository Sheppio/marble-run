import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Scene } from "@babylonjs/core/scene";
import type { TrackGeometry } from "../track/geometry";
import type { Marble } from "./marble";
import type { Race } from "./race";
import { SpringVector, smoothstep } from "./smoothing";

/**
 * The broadcast camera.
 *
 * It rides behind and above whoever is leading, using the track's own frame
 * rather than the marble's velocity — velocity-based chase cameras spin wildly
 * when a marble bounces, whereas the track frame is smooth by construction.
 * Framing opens up on descents and jumps so the drama is visible.
 *
 * Both the eye and the point it looks at are carried on critically damped
 * springs rather than lerped, so every move eases in as well as out. The look
 * point is deliberately lazier than the eye: yaw is the motion a viewer
 * notices, and letting the camera swing towards a corner slightly behind its
 * own travel is what stops a tight bend reading as a flick.
 */

export type CameraMode = "broadcast" | "reverse" | "chase" | "orbit" | "wide";

const MODE_LABELS: Record<CameraMode, string> = {
  broadcast: "Broadcast",
  reverse: "Oncoming",
  chase: "Follow",
  orbit: "Orbit",
  wide: "Wide",
};

/**
 * The two orbiting shots: the same circling overhead framing at two distances.
 *
 * Wide shows the run as an object and where the leader sits on it; orbit keeps
 * that sense of the shape while close enough to see which marble is which and
 * what the field is doing.
 */
const ORBIT_SHOTS = {
  orbit: { radius: 92, height: 74, lift: 40, smoothTime: 0.85 },
  wide: { radius: 180, height: 150, lift: 80, smoothTime: 1.1 },
} as const;

/** How long the shot takes to move across to a new subject, in seconds. */
const HANDOFF_SECONDS = 1.6;
/** Spring smooth time at the peak of a hand-off — deliberately very slack. */
const HANDOFF_SMOOTH_TIME = 1.5;
/**
 * How much lazier the look point is than the eye. Above about 1.5 the camera
 * stops tracking corners at all and the marble slides out of frame.
 */
const LOOK_LAG = 1.35;
/**
 * Ceiling on how fast the eye may travel, cm/s. Without it a hand-off to a
 * marble on the far side of the run starts as a whip pan however long the
 * smooth time is.
 */
const MAX_EYE_SPEED = 260;
/**
 * Spring smooth time for the default broadcast shot.
 *
 * Was 0.5s. The spring's peak angular speed scales with 1/smoothTime, so
 * slackening it is a direct lever on how hard the shot whips round on a
 * twisty stretch — measured peaks of 40-70°/s on tight seeds, still enough to
 * read as the picture snapping round rather than panning. Pushed out to 0.85s
 * on the same measurement: this is broadcast's default shot and gets the most
 * scrutiny, so it is worth the extra beat of lag behind a sudden move.
 */
const BROADCAST_SMOOTH_TIME = 0.85;

/**
 * How far ahead of the subject, in centreline points, the "oncoming" camera
 * plants itself. At `POINT_SPACING` = 1.2cm this is about 96cm of runway.
 *
 * Was 80 (96cm). Measured against real races that was barely a marble's own
 * travel time — the leader was already at or past the vantage point, or past
 * the edge of frame on a bend, within a second or two of the cut happening.
 * Tripled: enough runway that the field is a small shape a clear distance out
 * when the shot picks them up, with time to watch them close the gap.
 */
const REVERSE_LOOKAHEAD = 240;
/**
 * How close the subject may get to the current vantage point before the
 * camera jumps to a new one further on.
 *
 * Not zero: waiting for the marble to reach the exact anchor point would let
 * it fill the frame and roll past the camera before the cut happens. Jumping
 * a little early keeps the marble a comfortable distance out. Scaled up
 * alongside `REVERSE_LOOKAHEAD` so the cut still happens at roughly the same
 * fraction of the runway rather than firing almost immediately on the now much
 * longer approach.
 */
const REVERSE_RETRIGGER = 50;

/** Whether `value` names a camera mode this build actually has. */
export function isCameraMode(value: string | null | undefined): value is CameraMode {
  return (
    value === "broadcast" ||
    value === "reverse" ||
    value === "chase" ||
    value === "orbit" ||
    value === "wide"
  );
}

export class BroadcastCamera {
  readonly camera: FreeCamera;
  mode: CameraMode = "broadcast";
  /** Marble to follow in `chase` mode; falls back to the leader. */
  focus: Marble | null = null;

  private readonly eye = new SpringVector(new Vector3(0, 90, -140));
  private readonly look = new SpringVector(new Vector3(0, 0, 0));
  private swing = 0;
  /** Who the shot was on last frame, for spotting a hand-off. */
  private lastSubjectId: number | null = null;
  /** Counts down while a hand-off to a new subject is in progress. */
  private handoff = 0;
  /**
   * Centreline index the "oncoming" camera is currently planted at. -1 means
   * none picked yet — the first update in that mode always needs to choose
   * one anyway, so this doubles as the "just switched into reverse" flag.
   */
  private reverseAnchorIndex = -1;

  constructor(
    scene: Scene,
    private readonly geometry: TrackGeometry,
    initialMode?: CameraMode,
  ) {
    if (initialMode) this.mode = initialMode;
    this.camera = new FreeCamera("broadcast-cam", this.eye.value.clone(), scene);
    this.camera.minZ = 1;
    this.camera.maxZ = 4000;
    this.camera.fov = 0.82;
    scene.activeCamera = this.camera;
  }

  cycleMode(): CameraMode {
    // Ordered from tightest to widest, so cycling pulls steadily back.
    // "reverse" sits right after "broadcast" — the two are a pair, the same
    // distance from the action but facing opposite ways up the track.
    const order: CameraMode[] = ["broadcast", "reverse", "chase", "orbit", "wide"];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    return this.mode;
  }

  get modeLabel(): string {
    return MODE_LABELS[this.mode];
  }

  update(race: Race, dt: number): void {
    const subject = this.pickSubject(race);
    if (!subject) return;

    // The shot changes hands whenever the leader finishes and the race moves on
    // to whoever is next, who may be metres back. Rather than let the springs
    // deal with a step change that size, the move is given its own eased
    // window: the smoothing slackens right off, then tightens back up.
    if (this.lastSubjectId !== null && subject.player.id !== this.lastSubjectId) {
      this.handoff = HANDOFF_SECONDS;
      // The anchor was planted relative to whoever the shot was on before —
      // meaningless once it cuts to someone else, who could be anywhere on
      // the track. Forces a fresh one relative to the new subject below.
      this.reverseAnchorIndex = -1;
    }
    this.lastSubjectId = subject.player.id;
    this.handoff = Math.max(0, this.handoff - dt);
    // 0 settled, 1 just handed over. Eased at both ends so neither the start
    // nor the end of the transition has a visible corner in it.
    const handing = smoothstep(this.handoff / HANDOFF_SECONDS);

    const index = subject.progressIndex;
    const frame = this.geometry.frameAt(index);
    // Look a little way down the track so corners open up before they arrive.
    const lookAhead = this.geometry.frameAt(index + 10);

    this.swing += dt * 0.45;

    let desiredPosition: Vector3;
    let desiredTarget: Vector3;
    /** Seconds for the eye to settle; the look point gets a little longer. */
    let smoothTime: number;

    switch (this.mode) {
      case "reverse": {
        // A vantage point planted further down the track, watching the field
        // come towards it rather than riding along behind them. The point
        // itself doesn't move with the subject — it sits still until the
        // subject gets close, then jumps on to the next one, the way a fixed
        // camera at the trackside actually works.
        if (this.reverseAnchorIndex < 0 || index + REVERSE_RETRIGGER >= this.reverseAnchorIndex) {
          this.reverseAnchorIndex = index + REVERSE_LOOKAHEAD;
          this.handoff = HANDOFF_SECONDS;
        }
        const anchor = this.geometry.frameAt(this.reverseAnchorIndex);
        // Off to one side and raised, like a trackside camera rather than one
        // hanging directly over the channel — sitting on the centreline put
        // the marbles at the very edge of frame instead of approaching
        // through the middle of it. Both are bigger than a close-in shot
        // would need: the runway is long enough now to cross a bend, and a
        // camera sitting low and tight to the track loses the subject off the
        // side of frame the moment the track curves away from it.
        const lateral = 30 + Math.sin(this.swing) * 8;
        desiredPosition = anchor.position
          .add(anchor.right.scale(lateral))
          .add(anchor.up.scale(26));
        // Looking back at the subject, not ahead of it — the whole point of
        // this shot is watching it approach.
        desiredTarget = subject.position;
        smoothTime = BROADCAST_SMOOTH_TIME;
        break;
      }
      case "orbit":
      case "wide": {
        const shot = ORBIT_SHOTS[this.mode];
        // Rises a little with speed, so a fast passage opens the framing out.
        const height = shot.height + Math.min(shot.lift, subject.speed * 0.3);
        const angle = this.swing * 0.25;
        desiredPosition = frame.position.add(
          new Vector3(Math.cos(angle) * shot.radius, height, Math.sin(angle) * shot.radius),
        );
        desiredTarget = frame.position;
        smoothTime = shot.smoothTime;
        break;
      }
      case "chase": {
        const back = 22 + subject.speed * 0.08;
        desiredPosition = subject.position
          .subtract(frame.tangent.scale(back))
          .add(frame.up.scale(9))
          .add(new Vector3(0, 4, 0));
        desiredTarget = subject.position.add(frame.tangent.scale(20));
        smoothTime = 0.26;
        break;
      }
      default: {
        // Broadcast: sit off to one side and above, drifting slowly so the
        // shot never feels locked to a rail.
        // Far enough out to see the marble in the context of the track around it.
        // The run coils tightly at this scale, so a close chase camera ends up
        // inside the next loop down, looking at the underside of the channel.
        const back = 55 + subject.speed * 0.12;
        const height = 34 + subject.speed * 0.05;
        const lateral = Math.sin(this.swing) * 16;
        desiredPosition = subject.position
          .subtract(lookAhead.tangent.scale(back))
          .add(frame.right.scale(lateral))
          .add(new Vector3(0, height, 0));
        // Frame between the marble and the track ahead of it, weighted
        // towards the marble itself. Was an even 0.4 towards the track ahead,
        // which put the leader closer to the edge of frame than the centre —
        // fine on a straight, but on a bend the track-ahead point can swing
        // wide enough that the marble the shot is actually about is the thing
        // nearest falling out of it.
        desiredTarget = Vector3.Lerp(subject.position, lookAhead.position, 0.22);
        smoothTime = BROADCAST_SMOOTH_TIME;
        break;
      }
    }

    // During a hand-off both springs are slackened towards HANDOFF_SMOOTH_TIME,
    // which turns what would be a snap onto the new subject into a slow drift
    // across to them.
    const eyeSmooth = smoothTime + (HANDOFF_SMOOTH_TIME - smoothTime) * handing;
    // The look point trails the eye. This is the whole of the corner fix: the
    // camera arrives at the bend before it finishes turning to face it.
    const lookSmooth = eyeSmooth * LOOK_LAG;

    this.eye.step(desiredPosition, dt, eyeSmooth, MAX_EYE_SPEED);
    this.look.step(desiredTarget, dt, lookSmooth);
    this.apply();
  }

  /** Settles on the finish line for the results screen. */
  finishShot(dt: number): void {
    const frame = this.geometry.frameAt(this.geometry.plan.finishIndex + 8);
    // Well clear of the finish gantry and the support legs around it, and off
    // to one side, so the shot is of the finish line rather than of whatever
    // happened to be nearest the camera.
    const desired = frame.position
      .add(frame.tangent.scale(105))
      .add(frame.right.scale(40))
      .add(new Vector3(0, 60, 0));
    this.eye.step(desired, dt, 1.4, MAX_EYE_SPEED);
    this.look.step(frame.position, dt, 1.4);
    this.apply();
  }

  /**
   * Where the camera sits for the countdown: behind and above the grid, far
   * enough back to hold the whole field and the first stretch of track.
   */
  gridFraming(): { eye: Vector3; look: Vector3 } {
    const frame = this.geometry.frameAt(this.geometry.plan.startIndex);
    const eye = frame.position
      .subtract(frame.tangent.scale(26))
      .add(frame.right.scale(7))
      .add(new Vector3(0, 14, 0));
    // Just ahead of the grid rather than well down the track, so the marbles
    // sit in the middle of the frame instead of in a corner of it.
    const look = frame.position.add(frame.tangent.scale(5));
    return { eye, look };
  }

  /** Places the camera instantly, skipping the smoothing. */
  snapTo(position: Vector3, target: Vector3): void {
    this.eye.reset(position);
    this.look.reset(target);
    this.lastSubjectId = null;
    this.handoff = 0;
    this.apply();
  }

  private pickSubject(race: Race): Marble | null {
    if (this.mode === "chase" && this.focus) return this.focus;
    return race.getLeader();
  }

  private apply(): void {
    this.camera.position.copyFrom(this.eye.value);
    this.camera.setTarget(this.look.value);
  }
}
