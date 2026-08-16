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

export type CameraMode = "broadcast" | "chase" | "wide";

const MODE_LABELS: Record<CameraMode, string> = {
  broadcast: "Broadcast",
  chase: "Follow",
  wide: "Wide",
};

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

  constructor(
    scene: Scene,
    private readonly geometry: TrackGeometry,
  ) {
    this.camera = new FreeCamera("broadcast-cam", this.eye.value.clone(), scene);
    this.camera.minZ = 1;
    this.camera.maxZ = 4000;
    this.camera.fov = 0.82;
    scene.activeCamera = this.camera;
  }

  cycleMode(): CameraMode {
    const order: CameraMode[] = ["broadcast", "chase", "wide"];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    return this.mode;
  }

  get modeLabel(): string {
    return MODE_LABELS[this.mode];
  }

  /** Sweeps the whole track top to bottom, for the pre-race countdown. */
  previewAt(t: number): void {
    const index = t * (this.geometry.frames.length - 1);
    const frame = this.geometry.frameAt(index);
    const angle = t * Math.PI * 2.2;
    const radius = 130 + 45 * Math.sin(t * Math.PI);
    const position = frame.position.add(
      new Vector3(Math.cos(angle) * radius, 55 + 25 * Math.cos(t * Math.PI * 2), Math.sin(angle) * radius),
    );
    // Fixed blends rather than springs: the flythrough is on a scripted path
    // and wants to track it exactly, not lag behind it.
    this.eye.value.copyFrom(Vector3.Lerp(this.eye.value, position, 0.08));
    this.look.value.copyFrom(Vector3.Lerp(this.look.value, frame.position, 0.12));
    this.apply();
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
      case "wide": {
        const height = 150 + Math.min(80, subject.speed * 0.3);
        desiredPosition = frame.position
          .add(new Vector3(Math.cos(this.swing * 0.25) * 180, height, Math.sin(this.swing * 0.25) * 180));
        desiredTarget = frame.position;
        smoothTime = 1.1;
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
        // Frame between the marble and the track ahead of it.
        desiredTarget = Vector3.Lerp(subject.position, lookAhead.position, 0.4);
        smoothTime = 0.5;
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
