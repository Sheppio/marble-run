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
 * How close a wall-hugging pin sits to the true channel wall, edge to edge.
 *
 * `MIN_PIN_GAP` is deliberately wider than a marble so two pins in the same
 * row let one through between them — that is the field doing its job. Applied
 * at the wall too, the same gap becomes a lane straight past every pin: a
 * marble that hugs the side never has to touch anything. This is the residual
 * left once the wall-hugging pin closes that lane back down, small enough
 * that nothing a marble's own width can fit through it.
 */
const WALL_PIN_MARGIN = TRACK_CONSTANTS.marbleRadius * 0.4;

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
 * Shipped baffle sweep, in radians (about 40.1°).
 *
 * This is the single most important number for whether marbles get stuck.
 *
 * A marble held against a baffle face is only driven along it, towards the tip
 * and freedom, by the component of gravity that resolves onto the face:
 *
 *   F = m . g . sin(track gradient) . sin(sweep)
 *
 * Both terms are small and they multiply. The roll-away invariant pins the
 * minimum gradient at 4.9°, so sin(gradient) can be as little as 0.085; at the
 * old sweep of 17.2° that left about 2.5% of gravity driving the escape,
 * against 1.8% rolling resistance holding it back. A margin that thin is why
 * marbles stalled unpredictably rather than consistently.
 *
 * Widening the sweep is the direct fix, and it works about as well as the
 * algebra says. `npm run tune:baffles`, 60 seeds each:
 *
 *    5.7°   75.6% finish   28.3% all home   927 baffle stalls
 *   10.3°   84.7%          38.3%            363
 *   13.8°   93.1%          68.3%            229
 *   17.2°   94.7%          76.7%             92
 *   24.1°   98.6%          91.7%             22
 *   31.5°   99.2%          95.0%              8
 *   40.1°   99.7%          98.3%             13
 *
 * An earlier pass measured only the first four and concluded 17.2° was the
 * best available, which was true of what had been tried and quite wrong in
 * general — the sweep had been searched downwards from the shipped value and
 * never upwards.
 *
 * Those figures were taken at a reach of 0.7. Reach has since gone to 0.85,
 * and the two interact, so the choice between the top two was re-measured at
 * the current geometry. 150 seeds each:
 *
 *   31.5°   99.4% finish   96.7% all home   0.6 rescues   51 baffle stalls
 *   40.1°   99.2%          95.3%            0.6           43
 *
 * Level on everything except baffle-blamed incidents, where the wider sweep is
 * about a sixth better — and those incidents are the thing anyone actually
 * notices, since a marble stopped on a baffle collects the field behind it.
 * That is what decides it.
 *
 * Worth knowing how thin this is. At 60 seeds the same comparison had 31.5°
 * at a flawless 100% on both headline figures and 40.1° behind it, which read
 * as a clear regression and was noise: at 150 the gap closes to two races.
 * Anything at this scale needs the larger sample before it means anything.
 *
 * The trade is real but small in both directions: on the 100-seed tuning run
 * 31.5° keeps 97.0% of races with everyone home against 94.0% here, while this
 * setting is the better one on baffle-blamed incidents in every sample taken.
 * 31.5° is one constant away if the balance ever wants reversing.
 */
const BAFFLE_LEAN = 0.7;

/**
 * How far a baffle reaches across the channel, as a multiple of the channel's
 * half-width — so 0.85 blocks a bit over 40% of the full channel.
 *
 * This was cut to 0.7 from 1.05 to buy down stalls, back when the sweep angle
 * was still too shallow. That was treating the symptom: with the sweep fixed,
 * re-measuring at 60 seeds each shows most of the reach is affordable again.
 *
 *   0.70   99.2% finish   95.0% all home   0.7 rescues    8 baffle stalls
 *   0.85   99.4%          96.7%            0.8           17
 *   1.05   97.5%          86.7%            1.4           39
 *   1.25   95.6%          80.0%            1.7           54
 *
 * 0.85 is better than 0.70 on both finish rate and races with everyone home
 * while blocking more of the channel, so it is a free return of some of the
 * bunching. Past that it starts costing again: 1.05 is much healthier than it
 * used to be but still gives up two points of finish rate and doubles the
 * interventions, which is a taste call rather than an obvious win.
 */
const BAFFLE_REACH = 0.85;

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
 * Lateral offsets for one row of a staggered lattice — a pin field, or the
 * marbles on the start grid.
 *
 * Pins sit on a fixed pitch and every other row is offset by half of it, so a
 * gap in one row is covered by a pin in the next and there is no straight line
 * through the field. Positions come back ordered from the centre outwards, so
 * a caller wanting fewer than fit takes the innermost ones.
 *
 * The pitch has to be constant for this to work at all. An earlier version
 * spread each row evenly across the channel instead, which meant the spacing
 * changed with the number of pins in the row — so rows could not interlock
 * however far they were shifted, and the field ended up with clear channels
 * running down it that marbles simply flowed through. It also shifted whole
 * rows sideways rather than staggering them about the centre, which pushed the
 * outermost pin of every other row towards the wall.
 */
export function latticeOffsets(
  usableHalfWidth: number,
  pitch: number,
  staggered: boolean,
): number[] {
  const offsets: number[] = [];
  if (usableHalfWidth < 0 || pitch <= 0) return offsets;

  if (staggered) {
    // Straddling the centreline: ±pitch/2, ±3·pitch/2, ...
    for (let k = 0; (k + 0.5) * pitch <= usableHalfWidth; k++) {
      offsets.push((k + 0.5) * pitch, -(k + 0.5) * pitch);
    }
  } else {
    // Centred on the centreline: 0, ±pitch, ±2·pitch, ...
    offsets.push(0);
    for (let k = 1; k * pitch <= usableHalfWidth; k++) offsets.push(k * pitch, -k * pitch);
  }
  return offsets;
}

/** Diameter of a pin in a pin field, in cm. */
export const PIN_DIAMETER = 0.75;

/**
 * The lateral offsets for one row of a pin field, including the wall-hugging
 * pins that close off the side lanes.
 *
 * Exposed separately from `buildObstacles` so the tuning harness can check the
 * geometry directly — whether a marble squeezing down the very edge of the
 * channel can still do it without touching anything — without needing to
 * build and simulate a whole track to find out.
 *
 * Triangle rows are handled by the caller, not here: they are deliberately
 * narrower than the channel in their early rows, and closing that down would
 * remove the shape rather than fix a gap.
 */
export function pinRowOffsets(channelWidth: number, staggered: boolean): number[] {
  const pitch = PIN_DIAMETER + MIN_PIN_GAP;
  const usable = Math.max(0, channelWidth - MIN_PIN_GAP - PIN_DIAMETER * 0.5);
  const chosen = latticeOffsets(usable, pitch, staggered);

  const marbleWidth = TRACK_CONSTANTS.marbleRadius * 2;
  const outerPositive = Math.max(0, ...chosen);
  const wallPositive = channelWidth - PIN_DIAMETER / 2 - WALL_PIN_MARGIN;
  if (wallPositive - outerPositive > marbleWidth) chosen.push(wallPositive);
  const outerNegative = Math.min(0, ...chosen);
  const wallNegative = -(channelWidth - PIN_DIAMETER / 2 - WALL_PIN_MARGIN);
  if (outerNegative - wallNegative > marbleWidth) chosen.push(wallNegative);

  return chosen;
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
        // A regular field of pins: either a bowling triangle or a full grid.
        const isTriangle = p.pattern < 0.5;
        const height = 2.4;
        const rows = Math.round(p.rows);
        const rowGap = 3.2;

        const parts: Mesh[] = [];
        for (let r = 0; r < rows; r++) {
          const rowFrame = track(spec.index - ((rows - 1) * rowGap) / 2 + r * rowGap);
          // Half the rows are offset by half a pitch. A bowling triangle gets
          // this for free — row r holds r+1 pins, so odd rows hold an even
          // number and straddle the centreline — and a grid is told to.
          const staggered = r % 2 === 1;

          // Keep a marble-width gap between every pair of pins *and* between
          // the outermost pins and the walls, and — for a grid — a wall pin
          // wherever the regular lattice would otherwise leave a lane down the
          // side. See `pinRowOffsets`.
          //
          // Bowling: one pin in the front row, growing by one each row back,
          // and no wall pins — the open sides are the shape.
          // Grid: as many as the channel holds, wall pins included.
          const chosen = isTriangle
            ? latticeOffsets(
                Math.max(0, rowFrame.width - MIN_PIN_GAP - PIN_DIAMETER * 0.5),
                PIN_DIAMETER + MIN_PIN_GAP,
                staggered,
              ).slice(0, r + 1)
            : pinRowOffsets(rowFrame.width, staggered);

          for (const lateral of chosen) {
            const pin = CreateCylinder(
              "pin",
              {
                diameterTop: PIN_DIAMETER * 0.72,
                diameterBottom: PIN_DIAMETER,
                height,
                tessellation: 10,
              },
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
          // The baffle is built longer than its reach and pushed out by the
          // difference, so its root is buried in the wall and its tip lands
          // exactly where the reach says it should.
          //
          // Flush with the inner face of the wall was not enough: the sweep
          // rotates the baffle about its own centre, which swings the root
          // inward and leaves the whole upstream corner standing proud of the
          // wall in plain sight. Burying it is what hides that corner.
          //
          // Held under the shell thickness so the root stops inside the wall
          // rather than breaking out of the far side of it.
          const embed = Math.min(TRACK_CONSTANTS.shellThickness * 0.85, 1.0);
          const baffle = CreateBox(
            "baffle",
            { width: reach + embed, height, depth: thickness },
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
            .add(f.right.scale(side * (f.width - reach / 2 + embed / 2)))
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
