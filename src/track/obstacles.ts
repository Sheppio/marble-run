import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { createSurface } from "../render/materials";
import type { TrackGeometry, TrackFrame } from "./geometry";
import { TRACK_CONSTANTS, type ObstacleSpec } from "./plan";

/**
 * Obstacles.
 *
 * All of them are static: fixed geometry bolted to the track, exactly as a
 * wooden marble run has. Nothing spins, swings or opens on a timer.
 *
 * That is partly taste and partly physics. A kinematic obstacle pushes with
 * effectively infinite force, so it can pin a marble against a wall in a way
 * nothing recovers from; and at these speeds a marble carries so little
 * momentum that a moving part tends to stop it dead rather than deflect it.
 * Static shapes only ever redirect, which is what makes a run fun to watch.
 *
 * Layouts are regular — bowling-pin triangles, square grids, evenly spaced
 * baffles — rather than randomly scattered. A regular pattern reads as
 * something built on purpose; scattered pins read as noise.
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

/**
 * Every obstacle must leave at least this much clear channel for a marble to
 * get through — about half the channel, and three marbles side by side.
 *
 * Generous on purpose. A field of six marbles arrives as a queue, not as one
 * marble, and an obstacle that only lets them through single file turns into a
 * traffic jam: the leaders squeeze past and everyone behind grinds to a halt.
 */
const MIN_CLEAR_LANE = TRACK_CONSTANTS.marbleRadius * 5.0;
/** Gap between neighbouring pins in a pattern, edge to edge. */
const MIN_PIN_GAP = TRACK_CONSTANTS.marbleRadius * 3.4;

/** Rotation carrying local axes onto the track frame at `frame`. */
function frameRotation(frame: TrackFrame): Quaternion {
  const m = Matrix.Identity();
  Matrix.FromXYZAxesToRef(frame.right, frame.up, frame.tangent, m);
  return Quaternion.FromRotationMatrix(m);
}

/**
 * A triangular prism standing on the channel floor, apex pointing back up the
 * track so marbles arriving at it are split left or right.
 *
 * Built by hand rather than from a 3-sided cylinder, so the apex points
 * exactly where intended rather than wherever the builder happened to start
 * its first vertex.
 */
function createWedge(name: string, width: number, length: number, height: number, scene: Scene): Mesh {
  const halfWidth = width / 2;
  const halfLength = length / 2;

  // Apex upstream at -Z; the flat back face downstream at +Z.
  const footprint: Array<[number, number]> = [
    [0, -halfLength],
    [halfWidth, halfLength],
    [-halfWidth, halfLength],
  ];

  const positions: number[] = [];
  const indices: number[] = [];

  // Bottom face, then top face.
  for (const [x, z] of footprint) positions.push(x, 0, z);
  for (const [x, z] of footprint) positions.push(x, height, z);
  indices.push(0, 2, 1); // bottom, wound downward
  indices.push(3, 4, 5); // top

  // Three side walls.
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    indices.push(i, j, j + 3, i, j + 3, i + 3);
  }

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh, false);
  return mesh;
}

/** Lateral offsets for one row of a pattern, evenly spaced and centred. */
function rowOffsets(count: number, usableHalfWidth: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const spacing = (usableHalfWidth * 2) / (count - 1);
  return Array.from({ length: count }, (_, i) => -usableHalfWidth + i * spacing);
}

export function buildObstacles(
  scene: Scene,
  geometry: TrackGeometry,
  specs: ObstacleSpec[],
): ObstacleSet {
  const statics: PhysicsAggregate[] = [];
  const shadowCasters: Mesh[] = [];

  const materials = {
    pin: makeMaterial(scene, "#c8d0dd", { metallic: 0.85, roughness: 0.22 }),
    post: makeMaterial(scene, "#e0b14a", { metallic: 0.6, roughness: 0.3 }),
    timber: makeMaterial(scene, "#7d4f2a", { metallic: 0.0, roughness: 0.72 }),
    rubber: makeMaterial(scene, "#2c3446", { metallic: 0.0, roughness: 0.9 }),
  };

  const track = (index: number) => geometry.frameAt(index);

  /** Merges a batch of meshes into one static body. */
  const commit = (
    parts: Mesh[],
    material: PBRMaterial,
    physics: { restitution: number; friction: number },
  ) => {
    if (parts.length === 0) return;
    const merged = parts.length === 1 ? parts[0] : (Mesh.MergeMeshes(parts, true, true) as Mesh);
    merged.material = material;
    const aggregate = new PhysicsAggregate(
      merged,
      PhysicsShapeType.MESH,
      { mass: 0, ...physics },
      scene,
    );
    statics.push(aggregate);
    shadowCasters.push(merged);
  };

  for (const spec of specs) {
    const frame = track(spec.index);
    const p = spec.params;

    switch (spec.kind) {
      case "pins": {
        // A regular field of pins: either a bowling triangle or a square grid.
        const isTriangle = p.pattern < 0.5;
        const diameter = 0.75;
        const height = 2.4;
        const rows = Math.round(p.rows);
        const rowGap = 3.2;

        const parts: Mesh[] = [];
        for (let r = 0; r < rows; r++) {
          const rowFrame = track(spec.index - ((rows - 1) * rowGap) / 2 + r * rowGap);
          // Bowling: one pin in the front row, growing by one each row back.
          // Grid: the same count in every row.
          const wanted = isTriangle ? r + 1 : Math.round(p.columns);

          // How many pins fit while leaving a marble-width gap between every
          // pair *and* between the outermost pins and the walls. Counting only
          // the gaps between pins is the trap: it packs the outer pins hard
          // against the walls, and a marble wedges in the slot that leaves.
          const span = rowFrame.width * 2;
          const maxCount = Math.max(
            1,
            Math.floor((span - MIN_PIN_GAP) / (diameter + MIN_PIN_GAP)),
          );
          const count = Math.min(wanted, maxCount);
          const usable = Math.max(0, rowFrame.width - MIN_PIN_GAP - diameter * 0.5);

          for (const lateral of rowOffsets(count, usable)) {
            const pin = CreateCylinder(
              "pin",
              { diameterTop: diameter * 0.72, diameterBottom: diameter, height, tessellation: 10 },
              scene,
            );
            pin.rotationQuaternion = frameRotation(rowFrame);
            pin.position = rowFrame.position
              .add(rowFrame.right.scale(lateral))
              .add(rowFrame.up.scale(height / 2));
            parts.push(pin);
          }
        }
        commit(parts, materials.pin, { restitution: 0.4, friction: 0.15 });
        break;
      }

      case "wedge": {
        // Splits the field left and right. Sized so each side is a real lane.
        const length = 5.5;
        const height = 2.2;
        // Each side of the wedge has to be a lane in its own right.
        const width = Math.max(1.2, Math.min(frame.width * 0.55, frame.width * 2 - MIN_CLEAR_LANE));
        const wedge = createWedge("wedge", width, length, height, scene);
        wedge.rotationQuaternion = frameRotation(frame);
        wedge.position = frame.position.add(frame.right.scale(p.offset * frame.width * 0.3));
        commit([wedge], materials.timber, { restitution: 0.2, friction: 0.3 });
        break;
      }

      case "baffles": {
        // Short walls from alternating sides, so the run has to weave. Each
        // one leaves a clear lane past its tip, and is angled downstream so a
        // marble is deflected along it rather than stopped by it.
        const count = Math.round(p.count);
        const spacing = 5.5;
        const thickness = 0.7;
        const height = 2.2;

        const parts: Mesh[] = [];
        for (let i = 0; i < count; i++) {
          const f = track(spec.index - ((count - 1) * spacing) / 2 + i * spacing);
          const side = i % 2 === 0 ? -1 : 1;
          // Reaches across at most half the channel, so the lane past its tip
          // is always wide enough for several marbles to stream through.
          const reach = Math.max(1.0, Math.min(f.width * 0.55, f.width * 2 - MIN_CLEAR_LANE));
          const baffle = CreateBox(
            "baffle",
            { width: reach, height, depth: thickness },
            scene,
          );
          // Angled to present a guiding face to oncoming marbles. The lean is
          // measured, not assumed: leaning it the other way was tried and made
          // things markedly worse, roughly doubling the number of marbles that
          // came to rest against one.
          baffle.rotationQuaternion = Quaternion.RotationAxis(
            new Vector3(0, 1, 0),
            side * 0.3,
          ).multiply(frameRotation(f));
          baffle.position = f.position
            .add(f.right.scale(side * (f.width - reach / 2)))
            .add(f.up.scale(height / 2));
          parts.push(baffle);
        }
        commit(parts, materials.rubber, { restitution: 0.25, friction: 0.35 });
        break;
      }

      case "posts": {
        // A short row of stouter posts straight down the middle of the channel.
        const count = Math.round(p.count);
        const spacing = 4.0;
        const diameter = 1.5;
        const height = 2.2;

        const parts: Mesh[] = [];
        for (let i = 0; i < count; i++) {
          const f = track(spec.index - ((count - 1) * spacing) / 2 + i * spacing);
          // Same rule as the pins: never leave a slot against the wall that a
          // marble can wedge into.
          const usable = Math.max(0, f.width - MIN_PIN_GAP - diameter * 0.5);
          // Alternate side to side, in step, rather than at random.
          const lateral = (i % 2 === 0 ? -1 : 1) * usable * p.spread;
          const post = CreateCylinder(
            "post",
            { diameter, height, tessellation: 14 },
            scene,
          );
          post.rotationQuaternion = frameRotation(f);
          post.position = f.position
            .add(f.right.scale(lateral))
            .add(f.up.scale(height / 2));
          parts.push(post);
        }
        commit(parts, materials.post, { restitution: 0.45, friction: 0.15 });
        break;
      }

      case "divider": {
        // An island splitting the channel into two lanes for a while.
        const segments = Math.max(2, Math.round(p.length / 3));
        const parts: Mesh[] = [];
        for (let i = 0; i < segments; i++) {
          const f = track(spec.index - segments * 0.75 + i * 1.5);
          const wall = CreateBox("divider", { width: 0.6, height: 2.2, depth: 1.6 }, scene);
          wall.rotationQuaternion = frameRotation(f);
          wall.position = f.position
            .add(f.right.scale(p.offset * f.width))
            .add(f.up.scale(1.1));
          parts.push(wall);
        }
        commit(parts, materials.timber, { restitution: 0.2, friction: 0.35 });
        break;
      }
    }
  }

  return {
    // Nothing here moves, so there is nothing to advance.
    zones: [],
    shadowCasters,
    update() {},
    dispose() {
      for (const s of statics) {
        s.transformNode.dispose();
        s.dispose();
      }
    },
  };
}

function makeMaterial(
  scene: Scene,
  hex: string,
  options: { metallic: number; roughness: number },
): PBRMaterial {
  return createSurface(scene, `obstacle-${hex}`, Color3.FromHexString(hex), options);
}
