import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import { applyDetail, createSurface } from "../render/materials";
import type { DetailMaps } from "../render/textures";
import type { TrackGeometry, TrackFrame } from "./geometry";
import { TRACK_CONSTANTS, type ObstacleSpec } from "./plan";
import type { Theme } from "../render/theme";

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

/**
 * How far a baffle is swept downstream from square across the channel, in
 * radians.
 *
 * Read at build time rather than captured in a module constant, so the tuning
 * harness can override it — a constant is evaluated when the module loads,
 * which is before any page script gets to set one.
 */
function baffleLean(): number {
  return tuning("baffleLean", BAFFLE_LEAN);
}

/** How far a baffle reaches across the channel, as a multiple of half-width. */
function baffleReach(): number {
  return tuning("baffleReach", BAFFLE_REACH);
}

/** Contact friction on a baffle face. See `BAFFLE_FRICTION`. */
function baffleFriction(): number {
  return tuning("baffleFriction", BAFFLE_FRICTION);
}

function tuning(name: string, fallback: number): number {
  const overrides = (globalThis as { __tuning?: Record<string, number> }).__tuning;
  const value = overrides?.[name];
  return typeof value === "number" ? value : fallback;
}

/**
 * Shipped baffle sweep, in radians (about 14°).
 *
 * Swept, not square. The instinct is that a baffle angled hard across the
 * channel is what marbles jam against, and that relaxing it would let them
 * slide past — it is the opposite. `npm run tune:baffles` over 60 seeds each:
 *
 *   5.7°   75.6% finish   28.3% all home   927 baffle stalls
 *  10.3°   84.7%          38.3%            363
 *  13.8°   93.1%          68.3%            229
 *  17.2°   91.1%          71.7%            182
 *
 * A face closer to square across the channel stops a marble dead instead of
 * guiding it along to the tip, and once one stops the rest of the field piles
 * into it. Below about 13° that failure runs away.
 *
 * 13.8° looked like a free relaxation on finish rate alone, but it is not:
 * measured twice, it raises interventions consistently (4.5 -> 5.7 per race
 * over 60 seeds, 3.8 -> 4.9 over 100) and takes baffle-blamed stalls from 182
 * to 229. More marbles eventually get home, but more of them have to be
 * helped, and being helped is the thing that reads as a marble stuck on a
 * baffle. 17.2° is the best of the four on that measure, so it stays.
 *
 * The lever for sticking is the baffle's reach across the channel, not its
 * angle — see the reach comment below.
 */
const BAFFLE_LEAN = 0.3;

/**
 * How far a baffle reaches across the channel, as a multiple of the channel's
 * half-width — so 0.7 blocks about a third of the full channel and 1.05
 * blocks slightly more than half.
 *
 * This, not the angle, is the control on how much trouble baffles cause, and
 * it is close to linear. `npm run tune:baffles -- --knob baffleReach`, 60
 * seeds each:
 *
 *   0.55   97.2% finish   86.7% all home   1.5 rescues    51 baffle stalls
 *   0.70   94.7%          76.7%            2.2            92
 *   0.85   92.2%          70.0%            3.5           156
 *   1.05   91.1%          71.7%            4.5           182
 *
 * 1.05 reached past the centreline and made the field funnel through a single
 * gap, which bunches marbles up beautifully and is also what had one in four
 * races needing a marble helped off a baffle. 0.7 halves the stalls and still
 * blocks a third of the channel, which is enough to shuffle the order.
 *
 * The bunching is genuinely good to watch, so this is a taste call as much as
 * a measurement: the numbers say where each setting lands, not which one is
 * right.
 */
const BAFFLE_REACH = 0.7;

/** Contact friction between a marble and a baffle face. Measured below. */
const BAFFLE_FRICTION = 0.35;

/** Rotation carrying local axes onto the track frame at `frame`. */
export function frameRotation(frame: TrackFrame): Quaternion {
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
  const uvs: number[] = [];

  // Every face gets its own copy of its corners rather than sharing them round
  // the solid. Shared corners make `ComputeNormals` average across the edges,
  // and a five-faced solid with smoothed edges shades like a soft blob — the
  // wedge read as a paper shard rather than a block of wood.
  const face = (points: Array<[number, number, number]>) => {
    const base = positions.length / 3;
    for (const [x, y, z] of points) {
      positions.push(x, y, z);
      // Planar mapping, good enough for a solid this small.
      uvs.push(x * 0.2 + z * 0.2, y * 0.2);
    }
    for (let i = 2; i < points.length; i++) indices.push(base, base + i - 1, base + i);
  };

  const [apex, right, left] = footprint;
  const lo = (p: [number, number]): [number, number, number] => [p[0], 0, p[1]];
  const hi = (p: [number, number]): [number, number, number] => [p[0], height, p[1]];

  face([lo(apex), lo(left), lo(right)]); // bottom, wound downward
  face([hi(apex), hi(right), hi(left)]); // top
  face([lo(apex), lo(right), hi(right), hi(apex)]); // right cheek
  face([lo(left), lo(apex), hi(apex), hi(left)]); // left cheek
  face([lo(right), lo(left), hi(left), hi(right)]); // flat back

  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.uvs = uvs;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh, false);
  return mesh;
}

/**
 * Lateral offsets for one row of a pattern, evenly spaced and centred.
 *
 * `shift` moves the row sideways by that fraction of the pin spacing, which is
 * how the grid gets staggered: without it, every row sits directly behind the
 * one in front and a marble that threads the first row sails through all of
 * them untouched.
 */
function rowOffsets(count: number, usableHalfWidth: number, shift = 0): number[] {
  if (count <= 0) return [];
  if (count === 1) return [usableHalfWidth * shift];
  const spacing = (usableHalfWidth * 2) / (count - 1);
  return Array.from(
    { length: count },
    (_, i) => -usableHalfWidth + i * spacing + spacing * shift,
  );
}

export function buildObstacles(
  scene: Scene,
  geometry: TrackGeometry,
  specs: ObstacleSpec[],
  theme: Theme,
  detail: DetailMaps | null = null,
  relief = true,
): ObstacleSet {
  const statics: PhysicsAggregate[] = [];
  const shadowCasters: Mesh[] = [];

  const finish = theme.obstacles;
  const materials = {
    pin: createSurface(scene, `obs-pin-${theme.id}`, finish.pin.color, finish.pin.surface),
    post: createSurface(scene, `obs-post-${theme.id}`, finish.post.color, finish.post.surface),
    timber: createSurface(
      scene,
      `obs-structure-${theme.id}`,
      finish.structure.color,
      finish.structure.surface,
    ),
    rubber: createSurface(
      scene,
      `obs-barrier-${theme.id}`,
      finish.barrier.color,
      finish.barrier.surface,
    ),
  };

  // The structural obstacles are made of the same stuff as the run itself, so
  // they wear the same grain. Without it a wedge reads as a plastic prop
  // dropped onto a wooden track. Pins and posts stay smooth — they are metal.
  applyDetail(materials.timber, detail, relief);
  applyDetail(materials.rubber, detail, relief);

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
          // Every other row steps across by half a space. A triangle staggers
          // by construction; a grid has to be told to.
          const shift = isTriangle ? 0 : (r % 2) * 0.5;

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

          for (const lateral of rowOffsets(count, usable, shift)) {
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
        // Spaced out, so the field has room to re-form between them.
        const spacing = 8.0;
        const thickness = 0.7;
        // Below the wall top, so a marble riding over one is not trapped.
        const height = 1.6;

        const lean = baffleLean();
        const reachFactor = baffleReach();
        const parts: Mesh[] = [];
        for (let i = 0; i < count; i++) {
          const f = track(spec.index - ((count - 1) * spacing) / 2 + i * spacing);
          const side = i % 2 === 0 ? -1 : 1;
          // Reaches across at most half the channel, so the lane past its tip
          // is always wide enough for several marbles to stream through.
          // Reaches across most of the channel, so the field has to funnel
          // past the tip and bunches up doing it. This is the obstacle that
          // creates the most drama and also the most trouble — it is kept to
          // straights, where the banking is not already pressing marbles into
          // the wall it grows from.
          const reach = Math.max(1.0, Math.min(f.width * reachFactor, f.width * 2 - MIN_CLEAR_LANE));
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
            side * lean,
          ).multiply(frameRotation(f));
          baffle.position = f.position
            .add(f.right.scale(side * (f.width - reach / 2)))
            .add(f.up.scale(height / 2));
          parts.push(baffle);
        }
        commit(parts, materials.rubber, { restitution: 0.25, friction: baffleFriction() });
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
