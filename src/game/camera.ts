import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Scene } from "@babylonjs/core/scene";
import type { TrackGeometry } from "../track/geometry";
import type { Marble } from "./marble";
import type { Race } from "./race";

/**
 * The broadcast camera.
 *
 * It rides behind and above whoever is leading, using the track's own frame
 * rather than the marble's velocity — velocity-based chase cameras spin wildly
 * when a marble bounces, whereas the track frame is smooth by construction.
 * Framing opens up on descents and jumps so the drama is visible.
 */

export type CameraMode = "broadcast" | "chase" | "wide";

const MODE_LABELS: Record<CameraMode, string> = {
  broadcast: "Broadcast",
  chase: "Follow",
  wide: "Wide",
};

export class BroadcastCamera {
  readonly camera: FreeCamera;
  mode: CameraMode = "broadcast";
  /** Marble to follow in `chase` mode; falls back to the leader. */
  focus: Marble | null = null;

  private currentPosition = new Vector3(0, 90, -140);
  private currentTarget = new Vector3(0, 0, 0);
  private swing = 0;

  constructor(
    scene: Scene,
    private readonly geometry: TrackGeometry,
  ) {
    this.camera = new FreeCamera("broadcast-cam", this.currentPosition.clone(), scene);
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
    this.currentPosition = Vector3.Lerp(this.currentPosition, position, 0.08);
    this.currentTarget = Vector3.Lerp(this.currentTarget, frame.position, 0.12);
    this.apply();
  }

  update(race: Race, dt: number): void {
    const subject = this.pickSubject(race);
    if (!subject) return;

    const index = subject.progressIndex;
    const frame = this.geometry.frameAt(index);
    // Look a little way down the track so corners open up before they arrive.
    const lookAhead = this.geometry.frameAt(index + 10);

    this.swing += dt * 0.45;

    let desiredPosition: Vector3;
    let desiredTarget: Vector3;
    let responsiveness: number;

    switch (this.mode) {
      case "wide": {
        const height = 150 + Math.min(80, subject.speed * 0.3);
        desiredPosition = frame.position
          .add(new Vector3(Math.cos(this.swing * 0.25) * 180, height, Math.sin(this.swing * 0.25) * 180));
        desiredTarget = frame.position;
        responsiveness = 1.6;
        break;
      }
      case "chase": {
        const back = 22 + subject.speed * 0.08;
        desiredPosition = subject.position
          .subtract(frame.tangent.scale(back))
          .add(frame.up.scale(9))
          .add(new Vector3(0, 4, 0));
        desiredTarget = subject.position.add(frame.tangent.scale(20));
        responsiveness = 7.0;
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
        responsiveness = 3.4;
        break;
      }
    }

    // Exponential smoothing, expressed so it behaves the same at any framerate.
    const positionBlend = 1 - Math.exp(-responsiveness * dt);
    const targetBlend = 1 - Math.exp(-(responsiveness + 2.5) * dt);
    this.currentPosition = Vector3.Lerp(this.currentPosition, desiredPosition, positionBlend);
    this.currentTarget = Vector3.Lerp(this.currentTarget, desiredTarget, targetBlend);
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
    const blend = 1 - Math.exp(-1.8 * dt);
    this.currentPosition = Vector3.Lerp(this.currentPosition, desired, blend);
    this.currentTarget = Vector3.Lerp(this.currentTarget, frame.position, blend);
    this.apply();
  }

  /** Places the camera instantly, skipping the smoothing. */
  snapTo(position: Vector3, target: Vector3): void {
    this.currentPosition.copyFrom(position);
    this.currentTarget.copyFrom(target);
    this.apply();
  }

  private pickSubject(race: Race): Marble | null {
    if (this.mode === "chase" && this.focus) return this.focus;
    return race.getLeader();
  }

  private apply(): void {
    this.camera.position.copyFrom(this.currentPosition);
    this.camera.setTarget(this.currentTarget);
  }
}
