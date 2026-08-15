import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
import {
  PhysicsShapeBox,
  PhysicsShapeContainer,
} from "@babylonjs/core/Physics/v2/physicsShape";
import {
  PhysicsMotionType,
  PhysicsShapeType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Scene } from "@babylonjs/core/scene";
import type { TrackGeometry, TrackFrame } from "./geometry";
import { GRAVITY, POINT_SPACING, TRACK_CONSTANTS, type ObstacleSpec } from "./plan";

/**
 * Obstacles.
 *
 * Moving parts are kinematic (ANIMATED) bodies driven directly from simulation
 * time rather than from forces or constraints. That keeps them perfectly
 * repeatable for a given seed — a spinner is at the same angle at the same
 * simulated moment on every device — while still shoving marbles around with
 * full collision response.
 */

export interface ForceZone {
  /** Centreline index range this zone covers. */
  from: number;
  to: number;
  /** Force in world space, applied to any marble inside the range. */
  force(frame: TrackFrame, velocity: Vector3): Vector3;
}

export interface ObstacleSet {
  update(simTime: number): void;
  readonly zones: ForceZone[];
  readonly shadowCasters: Mesh[];
  dispose(): void;
}

interface Animated {
  body: PhysicsBody;
  mesh: Mesh;
  update(simTime: number): void;
}

/** One box in a compound shape: half-extents plus a local placement. */
interface BoxPart {
  extents: Vector3;
  position: Vector3;
  rotation: Quaternion;
}

/**
 * Builds a kinematic body whose collision shape is a set of boxes.
 *
 * Bladed obstacles have to be compound shapes: a convex hull of radial blades
 * is just a solid disc, which turns a spinner marbles are meant to slip past
 * into a wall that sweeps the channel.
 */
function makeCompoundBody(
  scene: Scene,
  mesh: Mesh,
  parts: BoxPart[],
  physics: { restitution: number; friction: number },
): PhysicsBody {
  const container = new PhysicsShapeContainer(scene);
  for (const part of parts) {
    const box = new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), part.extents, scene);
    container.addChild(box, part.position, part.rotation);
  }
  container.material = { friction: physics.friction, restitution: physics.restitution };

  const body = new PhysicsBody(mesh, PhysicsMotionType.ANIMATED, false, scene);
  body.shape = container;
  return body;
}

/**
 * Every obstacle must leave at least this much clear channel somewhere across
 * its width — comfortably more than two marbles side by side, so a queue can
 * still get through. Anything tighter can wedge a marble permanently against a
 * wall, and a kinematic obstacle pinning a marble is unrecoverable, because it
 * pushes with infinite force.
 */
const MIN_CLEAR_LANE = TRACK_CONSTANTS.marbleRadius * 3.6;

/** Rotation carrying local axes onto the track frame at `frame`. */
function frameRotation(frame: TrackFrame): Quaternion {
  const m = Matrix.Identity();
  Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
  return Quaternion.FromRotationMatrix(m);
}

function makeMaterial(scene: Scene, color: Color3, options: { metallic?: number; roughness?: number; glow?: number } = {}): PBRMaterial {
  const mat = new PBRMaterial(`obs-${color.toHexString()}-${options.glow ?? 0}`, scene);
  mat.albedoColor = color;
  mat.metallic = options.metallic ?? 0.25;
  mat.roughness = options.roughness ?? 0.45;
  if (options.glow) mat.emissiveColor = color.scale(options.glow);
  mat.environmentIntensity = 0.5;
  return mat;
}

export function buildObstacles(
  scene: Scene,
  geometry: TrackGeometry,
  specs: ObstacleSpec[],
): ObstacleSet {
  const animated: Animated[] = [];
  const statics: PhysicsAggregate[] = [];
  const decor: Mesh[] = [];
  const zones: ForceZone[] = [];
  const shadowCasters: Mesh[] = [];

  const materials = {
    hazard: makeMaterial(scene, Color3.FromHexString("#ff5c4d"), { metallic: 0.3, roughness: 0.35 }),
    metal: makeMaterial(scene, Color3.FromHexString("#b9c4d6"), { metallic: 0.75, roughness: 0.3 }),
    rubber: makeMaterial(scene, Color3.FromHexString("#2f3b52"), { metallic: 0.0, roughness: 0.85 }),
    boost: makeMaterial(scene, Color3.FromHexString("#3ddc97"), { glow: 0.9, roughness: 0.3 }),
    wind: makeMaterial(scene, Color3.FromHexString("#79c8ff"), { glow: 0.5, roughness: 0.4 }),
    bumper: makeMaterial(scene, Color3.FromHexString("#ffcf3d"), { glow: 0.35, roughness: 0.4 }),
  };

  const track = (index: number) => geometry.frameAt(index);

  for (const spec of specs) {
    const frame = track(spec.index);
    const rot = frameRotation(frame);
    const p = spec.params;

    switch (spec.kind) {
      case "spinner": {
        // Radial paddles sweeping the channel around the track's up axis.
        // Blade tips stop short of the walls, leaving a squeeze past either
        // side; a spinner that swept the full channel would simply pin
        // whatever it caught against the wall.
        const bladeCount = Math.round(p.blades);
        const halfReach = Math.max(0.8, frame.width - MIN_CLEAR_LANE);
        const bladeHeight = 1.2;
        const bladeThickness = 0.18;

        const blades: Mesh[] = [];
        const parts: BoxPart[] = [];
        for (let i = 0; i < bladeCount; i++) {
          const angle = (i / bladeCount) * Math.PI * 2;
          const blade = CreateBox(
            "blade",
            { width: halfReach * 2, height: bladeHeight, depth: bladeThickness * 2 },
            scene,
          );
          blade.rotation.y = angle;
          blade.bakeCurrentTransformIntoVertices();
          blades.push(blade);
          parts.push({
            extents: new Vector3(halfReach * 2, bladeHeight, bladeThickness * 2),
            position: Vector3.Zero(),
            rotation: Quaternion.RotationAxis(new Vector3(0, 1, 0), angle),
          });
        }
        const merged = Mesh.MergeMeshes(blades, true, true) as Mesh;
        merged.material = materials.hazard;
        // Sit the blades so they strike the upper half of a marble. Sweeping
        // at floor level lets a kinematic paddle press a marble into the
        // channel and hold it there, which nothing can recover from.
        merged.position = frame.position.add(
          frame.up.scale(TRACK_CONSTANTS.marbleRadius * 1.5 + bladeHeight * 0.5),
        );
        merged.rotationQuaternion = rot.clone();

        const body = makeCompoundBody(scene, merged, parts, { restitution: 0.35, friction: 0.2 });
        const basePos = merged.position.clone();
        const spinAxis = frame.up.clone();
        animated.push({
          body,
          mesh: merged,
          update(simTime) {
            const angle = p.phase + simTime * p.speed * Math.PI;
            const spin = Quaternion.RotationAxis(spinAxis, angle);
            body.setTargetTransform(basePos, spin.multiply(rot));
          },
        });
        shadowCasters.push(merged);
        break;
      }

      case "pendulum": {
        // A weight on an arm, pivoting on an axis across the channel.
        const arm = CreateBox("arm", { width: 0.3, height: 5.5, depth: 0.3 }, scene);
        arm.position.y = -2.75;
        arm.bakeCurrentTransformIntoVertices();
        const weight = CreateSphere("weight", { diameter: 2.2, segments: 10 }, scene);
        weight.position.y = -5.5;
        weight.bakeCurrentTransformIntoVertices();
        const merged = Mesh.MergeMeshes([arm, weight], true, true) as Mesh;
        merged.material = materials.metal;

        const pivot = frame.position.add(frame.up.scale(7.2));
        merged.position = pivot.clone();
        merged.rotationQuaternion = rot.clone();

        const aggregate = new PhysicsAggregate(
          merged,
          PhysicsShapeType.CONVEX_HULL,
          { mass: 1, restitution: 0.5, friction: 0.2 },
          scene,
        );
        aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);

        const swingAxis = frame.tangent.clone();
        animated.push({
          body: aggregate.body,
          mesh: merged,
          update(simTime) {
            const angle = Math.sin((simTime / p.period) * Math.PI * 2 + p.phase) * p.swing;
            const swing = Quaternion.RotationAxis(swingAxis, angle);
            aggregate.body.setTargetTransform(pivot, swing.multiply(rot));
          },
        });
        shadowCasters.push(merged);
        break;
      }

      case "drum": {
        // Paddle wheel on an axle across the track — marbles pass between
        // blades. Compound boxes again, for the same reason as the spinner,
        // and because Havok does not simulate a moving concave mesh reliably.
        const slots = Math.round(p.slots);
        const bladeDepth = 3.4;
        const bladeHeight = 3.6;
        const bladeThickness = 0.22;

        const blades: Mesh[] = [];
        const parts: BoxPart[] = [];
        for (let i = 0; i < slots; i++) {
          const angle = (i / slots) * Math.PI * 2;
          const blade = CreateBox(
            "dblade",
            { width: bladeThickness * 2, height: bladeHeight, depth: bladeDepth },
            scene,
          );
          blade.rotation.x = angle;
          blade.bakeCurrentTransformIntoVertices();
          blades.push(blade);
          parts.push({
            extents: new Vector3(bladeThickness * 2, bladeHeight, bladeDepth),
            position: Vector3.Zero(),
            rotation: Quaternion.RotationAxis(new Vector3(1, 0, 0), angle),
          });
        }
        const merged = Mesh.MergeMeshes(blades, true, true) as Mesh;
        merged.material = materials.hazard;
        merged.position = frame.position.add(frame.up.scale(1.5));
        merged.rotationQuaternion = rot.clone();

        const body = makeCompoundBody(scene, merged, parts, { restitution: 0.3, friction: 0.25 });
        const basePos = merged.position.clone();
        const axle = frame.right.clone();
        animated.push({
          body,
          mesh: merged,
          update(simTime) {
            const spin = Quaternion.RotationAxis(axle, simTime * p.speed * Math.PI);
            body.setTargetTransform(basePos, spin.multiply(rot));
          },
        });
        shadowCasters.push(merged);
        break;
      }

      case "gate": {
        // A barrier that swings out of the way on a fixed cycle.
        // Hinged at one wall and stopping short of the other, so the gate
        // redirects traffic rather than sealing the channel shut.
        const side = p.leaves > 1.5 ? 1 : -1;
        const width = Math.max(1.2, frame.width * 2 - MIN_CLEAR_LANE);
        const gate = CreateBox("gate", { width, height: 2.5, depth: 0.4 }, scene);
        gate.material = materials.rubber;
        const pivot = frame.position
          .add(frame.up.scale(1.25))
          .add(frame.right.scale(side * frame.width))
          .add(frame.right.scale(-side * width * 0.5));
        gate.position = pivot.clone();
        gate.rotationQuaternion = rot.clone();

        const aggregate = new PhysicsAggregate(
          gate,
          PhysicsShapeType.BOX,
          { mass: 1, restitution: 0.2, friction: 0.4 },
          scene,
        );
        aggregate.body.setMotionType(PhysicsMotionType.ANIMATED);

        const hingeAxis = frame.up.clone();
        animated.push({
          body: aggregate.body,
          mesh: gate,
          update(simTime) {
            // Smoothly held open, then shut: a shaped sine rather than a flat cycle.
            const cycle = Math.sin((simTime / p.period) * Math.PI * 2 + p.phase);
            const open = Math.sign(cycle) * Math.pow(Math.abs(cycle), 0.4);
            const swing = Quaternion.RotationAxis(hingeAxis, open * 0.85);
            aggregate.body.setTargetTransform(pivot, swing.multiply(rot));
          },
        });
        shadowCasters.push(gate);
        break;
      }

      case "pegs": {
        // Pachinko: staggered rows of posts in a widened section.
        const posts: Mesh[] = [];
        const rows = Math.round(p.rows);
        const pegDiameter = 0.7;
        for (let r = 0; r < rows; r++) {
          const rowFrame = track(spec.index - (rows * 2.4) / 2 + r * 2.4);
          const stagger = (r % 2) * p.stagger;
          // Fit as many pegs across as still leaves marble-width lanes between
          // them, rather than trusting a hard-coded count to suit every width.
          const span = rowFrame.width * 1.7;
          const perRow = Math.max(
            1,
            Math.min(
              Math.round(p.perRow),
              Math.floor((span - MIN_CLEAR_LANE) / (pegDiameter + MIN_CLEAR_LANE)),
            ),
          );
          for (let c = 0; c < perRow; c++) {
            const lateral =
              ((c + 0.5) / perRow - 0.5) * span + stagger * rowFrame.width * 0.3;
            const post = CreateCylinder(
              "peg",
              { diameter: pegDiameter, height: 2.2, tessellation: 8 },
              scene,
            );
            post.rotationQuaternion = frameRotation(rowFrame);
            post.position = rowFrame.position
              .add(rowFrame.right.scale(lateral))
              .add(rowFrame.up.scale(1.1));
            posts.push(post);
          }
        }
        const merged = Mesh.MergeMeshes(posts, true, true) as Mesh;
        merged.material = materials.metal;
        const aggregate = new PhysicsAggregate(
          merged,
          PhysicsShapeType.MESH,
          { mass: 0, restitution: 0.42, friction: 0.2 },
          scene,
        );
        statics.push(aggregate);
        shadowCasters.push(merged);
        break;
      }

      case "bumpers": {
        // Springy posts that fling marbles sideways.
        const posts: Mesh[] = [];
        const count = Math.round(p.count);
        for (let i = 0; i < count; i++) {
          const f = track(spec.index - (count * 3.2) / 2 + i * 3.2);
          // Keep a clear lane either side, so a bumper deflects a marble
          // rather than wedging it against the wall.
          const maxOffset = Math.max(0, f.width - MIN_CLEAR_LANE * 0.75);
          const lateral = (i % 2 === 0 ? -1 : 1) * Math.min(f.width * 0.45, maxOffset);
          const post = CreateCylinder(
            "bumper",
            { diameter: 1.1, height: 2.1, tessellation: 12 },
            scene,
          );
          post.rotationQuaternion = frameRotation(f);
          post.position = f.position.add(f.right.scale(lateral)).add(f.up.scale(1.05));
          posts.push(post);
        }
        const merged = Mesh.MergeMeshes(posts, true, true) as Mesh;
        merged.material = materials.bumper;
        const aggregate = new PhysicsAggregate(
          merged,
          PhysicsShapeType.MESH,
          // Capped well below 1: an over-bouncy post throws marbles backwards
          // up the track, where they oscillate instead of racing.
          { mass: 0, restitution: Math.min(0.62, p.bounce), friction: 0.12 },
          scene,
        );
        statics.push(aggregate);
        shadowCasters.push(merged);
        break;
      }

      case "divider": {
        // An island splitting the channel — pick a side and hope.
        const segments = Math.max(2, Math.round(p.length / 3));
        const walls: Mesh[] = [];
        for (let i = 0; i < segments; i++) {
          const f = track(spec.index - segments * 0.75 + i * 1.5);
          const wall = CreateBox("divider", { width: 0.55, height: 2.3, depth: 3.2 }, scene);
          wall.rotationQuaternion = frameRotation(f);
          wall.position = f.position
            .add(f.right.scale(p.offset * f.width))
            .add(f.up.scale(1.15));
          walls.push(wall);
        }
        const merged = Mesh.MergeMeshes(walls, true, true) as Mesh;
        merged.material = materials.rubber;
        const aggregate = new PhysicsAggregate(
          merged,
          PhysicsShapeType.MESH,
          { mass: 0, restitution: 0.2, friction: 0.35 },
          scene,
        );
        statics.push(aggregate);
        shadowCasters.push(merged);
        break;
      }

      case "boost": {
        const span = Math.max(2, Math.round(p.length / POINT_SPACING));
        const from = spec.index - span / 2;
        const to = spec.index + span / 2;
        // Visual pad only — the push comes from the force zone.
        for (let i = 0; i < span; i++) {
          const f = track(from + i);
          const pad = CreateBox("boost-pad", { width: f.width * 1.7, height: 0.1, depth: POINT_SPACING }, scene);
          pad.rotationQuaternion = frameRotation(f);
          pad.position = f.position.add(f.up.scale(0.06));
          pad.material = materials.boost;
          pad.isPickable = false;
          decor.push(pad);
        }
        zones.push({
          from,
          to,
          // `strength` is in g, so the shove keeps its meaning at any scale.
          force: (f) => f.tangent.scale(p.strength * GRAVITY),
        });
        break;
      }

      case "fan": {
        const span = Math.max(2, Math.round(p.length / POINT_SPACING));
        const from = spec.index - span / 2;
        const to = spec.index + span / 2;
        for (let i = 0; i < span; i += 2) {
          const f = track(from + i);
          const vane = CreateBox("vane", { width: 0.3, height: 1.8, depth: 1.8 }, scene);
          vane.rotationQuaternion = frameRotation(f);
          vane.position = f.position
            .add(f.right.scale(Math.sign(p.strength) * f.width * 1.25))
            .add(f.up.scale(1.4));
          vane.material = materials.wind;
          vane.isPickable = false;
          decor.push(vane);
        }
        zones.push({
          from,
          to,
          force: (f) => f.right.scale(-p.strength * GRAVITY),
        });
        break;
      }
    }
  }

  for (const m of decor) m.freezeWorldMatrix();

  return {
    zones,
    shadowCasters,
    update(simTime) {
      for (const a of animated) a.update(simTime);
    },
    dispose() {
      for (const a of animated) {
        a.body.dispose();
        a.mesh.dispose();
      }
      for (const s of statics) {
        s.transformNode.dispose();
        s.dispose();
      }
      for (const d of decor) d.dispose();
    },
  };
}
