import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import {
  PhysicsMotionType,
  PhysicsShapeType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import { TRACK_CONSTANTS } from "../track/plan";

export interface Player {
  id: number;
  name: string;
  /** Hex colour, e.g. "#ff5c4d". */
  color: string;
}

/**
 * Physical properties of a marble — glass, and identical for everyone.
 *
 * Mass is nominal rather than the real 5.4 grams. Every marble has the same
 * mass, kinematic obstacles behave as though infinitely heavy, and gravity is
 * an acceleration, so the actual figure never affects the result; keeping it
 * at 1 lets applied forces be written directly as accelerations.
 */
const MARBLE = {
  radius: TRACK_CONSTANTS.marbleRadius,
  mass: 1,
  restitution: 0.28,
  friction: 0.22,
  // Damping is left near zero: rolling losses are modelled explicitly in the
  // race step, where they can be expressed as a proper resistance coefficient.
  linearDamping: 0.01,
  angularDamping: 0.04,
};

export class Marble {
  readonly mesh: Mesh;
  readonly aggregate: PhysicsAggregate;

  /** Fractional centreline index of the marble's current position. */
  progressIndex = 0;
  /** Arc-length distance travelled along the track, metres. */
  distance = 0;
  /** Highest distance reached — ranking uses this so knocks-back don't reorder. */
  bestDistance = 0;
  finished = false;
  finishTime: number | null = null;
  /** Final placing, 1-based. Assigned when the race ends. */
  place = 0;

  /** Seconds spent off the track or motionless, used by the recovery logic. */
  offTrackFor = 0;
  stalledFor = 0;
  /** Seconds since this marble last made real forward progress. */
  noProgressFor = 0;
  /** Distance mark that `noProgressFor` is measured against. */
  progressWatermark = 0;
  /** Number of times this marble had to be rescued. */
  rescues = 0;
  /** Where the last rescue put it, for spotting a marble stuck in a loop. */
  lastRescueIndex = -999;
  /** Consecutive rescues at the same trouble spot. */
  repeatRescues = 0;
  /** Current speed in m/s, for the HUD. */
  speed = 0;
  /** Running speed statistics, for tuning. */
  peakSpeed = 0;
  speedSum = 0;
  speedSamples = 0;
  /** Diagnostics: how far outside the channel this marble drifted. */
  lastLateral = 0;
  lastVertical = 0;
  lastInGap = false;
  /** Diagnostics: the marble's state at the instant it left the channel. */
  departureSide = 0;
  departureUp = 0;
  departureSpeed = 0;
  departureWidth = 0;
  departureWall = 0;
  /** True for the single step during which a teleport is being applied. */
  teleporting = false;
  /** Simulated time at which a finished marble should leave the track. */
  retireAt: number | null = null;
  /** True once the physics body has been removed after finishing. */
  retired = false;
  private retireProgress = 0;

  constructor(
    scene: Scene,
    readonly player: Player,
    position: Vector3,
  ) {
    this.mesh = CreateSphere(
      `marble-${player.id}`,
      { diameter: MARBLE.radius * 2, segments: 12 },
      scene,
    );
    this.mesh.position.copyFrom(position);
    this.mesh.isPickable = false;

    const color = Color3.FromHexString(player.color);
    const material = new PBRMaterial(`marble-mat-${player.id}`, scene);
    material.albedoColor = color;
    material.metallic = 0.15;
    material.roughness = 0.06;
    material.environmentIntensity = 1.0;
    // A touch of self-illumination keeps every marble readable against a dark
    // track, even the ones in shadow at the back of the pack.
    material.emissiveColor = color.scale(0.16);
    this.mesh.material = material;

    this.aggregate = new PhysicsAggregate(
      this.mesh,
      PhysicsShapeType.SPHERE,
      {
        mass: MARBLE.mass,
        restitution: MARBLE.restitution,
        friction: MARBLE.friction,
        radius: MARBLE.radius,
      },
      scene,
    );
    this.aggregate.body.setLinearDamping(MARBLE.linearDamping);
    this.aggregate.body.setAngularDamping(MARBLE.angularDamping);
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  get velocity(): Vector3 {
    return this.aggregate.body.getLinearVelocity();
  }

  setVelocity(v: Vector3): void {
    this.aggregate.body.setLinearVelocity(v);
  }

  /**
   * Drops the marble back into the channel at `position`, at rest.
   *
   * Moving a dynamic body means letting the plugin push the mesh transform
   * into the simulation for exactly one step, so the flag is cleared again by
   * the race loop once that step has run.
   */
  teleport(position: Vector3): void {
    this.aggregate.body.disablePreStep = false;
    this.teleporting = true;
    this.mesh.position.copyFrom(position);
    this.aggregate.body.setLinearVelocity(Vector3.Zero());
    this.aggregate.body.setAngularVelocity(Vector3.Zero());
  }

  /** Called by the race loop after the step that consumed a teleport. */
  settleTeleport(): void {
    if (!this.teleporting) return;
    this.teleporting = false;
    this.aggregate.body.disablePreStep = true;
  }

  /** Holds the marble in the start gate. Kinematic bodies cannot drift. */
  freeze(): void {
    this.aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);
  }

  release(): void {
    this.aggregate.body.setMotionType(PhysicsMotionType.DYNAMIC);
    this.aggregate.body.setLinearVelocity(Vector3.Zero());
    this.aggregate.body.setAngularVelocity(Vector3.Zero());
  }

  /**
   * Takes a finished marble out of the simulation.
   *
   * Finishers used to pile up in the catch basin and back up over the line,
   * blocking marbles still racing. Retiring them removes the traffic jam and
   * saves the physics work of simulating marbles whose race is over.
   */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.aggregate.dispose();
  }

  /** Shrinks a retired marble away. Visual only, so it runs on frame time. */
  updateVisual(dt: number): void {
    if (!this.retired || this.retireProgress >= 1) return;
    this.retireProgress = Math.min(1, this.retireProgress + dt * 2.2);
    const scale = 1 - this.retireProgress;
    this.mesh.scaling.setAll(Math.max(0.001, scale));
    if (this.retireProgress >= 1) this.mesh.setEnabled(false);
  }

  dispose(): void {
    if (!this.retired) this.aggregate.dispose();
    this.mesh.material?.dispose();
    this.mesh.dispose();
  }
}

export const MARBLE_PROPERTIES = MARBLE;
