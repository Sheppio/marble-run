import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Rng } from "../core/rng";
import {
  GRAVITY,
  MAX_MARBLE_SPEED,
  PHYSICS,
  POINT_SPACING,
  TRACK_CONSTANTS,
  type GapSpec,
  type ObstacleKind,
  type ObstacleSpec,
  type TrackPlan,
} from "./plan";

/**
 * Track generation.
 *
 * A cursor walks downhill from the start gate, and each segment steers it:
 * turns bend the heading, spirals wind it down, drops steepen it. The raw walk
 * is then resampled to an even spacing so that everything downstream (mesh
 * sweeping, obstacle placement, progress tracking) can index the centreline by
 * distance.
 *
 * The one hard constraint is that the track must never pass through itself. A
 * spatial hash checks each proposed segment against everything already laid
 * down; a segment that would collide is thrown away and re-rolled.
 */

interface Cursor {
  pos: Vector3;
  yaw: number; // heading in the XZ plane, radians
}

interface RawPoint {
  pos: Vector3;
  width: number;
  /** Marks points inside a jump gap so the builder can leave the floor out. */
  gap: boolean;
}

/**
 * Segment kinds.
 *
 * There are deliberately no helical shapes here. A spiral or a funnel only
 * works if the run is allowed to pass over itself; laid out flat, its second
 * turn lands on top of its first. Worse, a segment was only ever checked
 * against track already committed, so a self-overlapping coil was accepted
 * happily — and then blocked so much ground that nothing could be placed after
 * it. Some seeds ended up as a single coil and nothing else.
 */
type SegmentKind =
  | "straight"
  | "turn"
  | "chicane"
  | "drop"
  | "wave"
  | "wide";

const SEGMENT_WEIGHTS: Record<SegmentKind, number> = {
  straight: 2.2,
  turn: 3.0,
  chicane: 1.6,
  drop: 1.2,
  wave: 1.0,
  wide: 1.4,
};

/** Horizontal step between raw samples while walking, in cm. */
const WALK_STEP = 2;
/**
 * Keep the run inside roughly this radius, in cm — a run that fits on a large
 * table, and frames well on a phone screen.
 */
const ARENA_RADIUS = 260;
/**
 * Minimum distance between two passes of track, measured on the ground.
 *
 * Height is deliberately not considered. The run is laid out so that no part
 * of it ever passes over or under another part: it descends by spreading out
 * across the ground, like a path down a hillside, rather than by stacking
 * loops on top of each other. A stacked run is hard to film — the camera is
 * forever looking at the underside of the loop above — and hard to read.
 */
const MIN_XZ_CLEARANCE = 22;
/**
 * How much of the walk immediately behind the cursor is exempt from the
 * self-intersection test, in samples.
 *
 * Long enough to cover the run-up and a tight bend (a U-turn at the minimum
 * corner radius is about 40 samples), short enough that a spiral coming back
 * round on itself a full turn later is still caught.
 */
const SELF_CLEARANCE_LOOKBACK = 42;
/**
 * Cornering budget, in g. Corners are generated no tighter than this allows at
 * the speed a marble will be doing there. Designing corners for the actual
 * speed is what stops marbles riding up the wall and out; the alternative —
 * curling the channel lip further over — contains them but scrubs so much
 * speed that the race stops being a race.
 */
const MAX_LATERAL_G = 1.15;
/**
 * How much of gravity a crest is allowed to use up. Below 1 the marble stays
 * pressed to the track over the top of a rise instead of taking off.
 */
const CREST_G_BUDGET = 0.55;
/**
 * How much steeper than the bare stationary-marble threshold the track must
 * be everywhere. Comfortably above 1, so a marble set down anywhere rolls off
 * with intent rather than creeping.
 */
const DESCENT_SAFETY_FACTOR = 3.4;
/**
 * How much of a wave segment's descent its own gradient may use up. Below 1
 * the track still runs downhill everywhere, so a marble never has to climb.
 */
const WAVE_GRADIENT_BUDGET = 0.7;

/**
 * Coarse spatial hash over XZ, used only for the self-intersection test.
 *
 * Each point remembers its ordinal along the walk, and the test ignores
 * anything laid down within `SELF_CLEARANCE_LOOKBACK` samples of the current
 * tail. Without that exclusion the check is trivially self-defeating: the
 * point a couple of centimetres behind the cursor is always "too close", so
 * every proposed segment collides with its own beginning and no segment can
 * ever be placed.
 */
class OccupancyGrid {
  private cells = new Map<string, Array<{ point: Vector3; ordinal: number }>>();
  private readonly cellSize = MIN_XZ_CLEARANCE;
  private nextOrdinal = 0;

  private key(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
  }

  add(p: Vector3): void {
    const entry = { point: p, ordinal: this.nextOrdinal++ };
    const k = this.key(p.x, p.z);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(entry);
    else this.cells.set(k, [entry]);
  }

  /** How many points have been laid down so far. */
  get count(): number {
    return this.nextOrdinal;
  }

  /**
   * True if `p` runs into track laid down earlier — ignoring the stretch
   * immediately behind the cursor, which is the track it is continuing from.
   */
  conflicts(p: Vector3, ignoreNewerThan: number): boolean {
    const cx = Math.floor(p.x / this.cellSize);
    const cz = Math.floor(p.z / this.cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.cells.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          if (entry.ordinal > ignoreNewerThan) continue;
          const q = entry.point;
          const ddx = q.x - p.x;
          const ddz = q.z - p.z;
          if (ddx * ddx + ddz * ddz < MIN_XZ_CLEARANCE * MIN_XZ_CLEARANCE) return true;
        }
      }
    }
    return false;
  }
}

class TrackWalker {
  readonly points: RawPoint[] = [];
  readonly grid = new OccupancyGrid();
  cursor: Cursor;
  /**
   * Running estimate of how fast a marble will be going here, from the drop
   * accumulated so far. Corners are sized against it — a corner that is fine
   * at the top of the run is a launch ramp two hundred metres later.
   */
  private speedSquared = 0.25;

  constructor(start: Vector3, yaw: number) {
    this.cursor = { pos: start.clone(), yaw };
  }

  get speed(): number {
    return Math.sqrt(this.speedSquared);
  }

  /**
   * Smallest corner radius that keeps lateral acceleration within what a
   * banked channel can hold at the current speed.
   */
  get minCornerRadius(): number {
    return Math.max(12, this.speedSquared / (MAX_LATERAL_G * GRAVITY));
  }

  private advanceSpeed(from: Vector3, to: Vector3): void {
    const ds = Vector3.Distance(from, to);
    const drop = from.y - to.y;
    this.speedSquared += (10 / 7) * GRAVITY * drop - 2 * PHYSICS.rollingResistance * GRAVITY * ds;
    this.speedSquared = Math.max(
      0.25,
      Math.min(MAX_MARBLE_SPEED * MAX_MARBLE_SPEED, this.speedSquared),
    );
  }

  /** Distance from the arena centre, used to steer the walk back inwards. */
  get radialDistance(): number {
    return Math.hypot(this.cursor.pos.x, this.cursor.pos.z);
  }

  /**
   * The turn direction that heads back toward the middle of the arena.
   * +1 means "turn left", matching the sign convention of `yaw`.
   */
  get inwardTurnSign(): number {
    const toCentre = Math.atan2(-this.cursor.pos.z, -this.cursor.pos.x);
    let delta = toCentre - this.cursor.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta >= 0 ? 1 : -1;
  }

  /**
   * Tries to append a run of points. Returns false (having changed nothing) if
   * any of them would collide with track already laid down.
   */
  tryAppend(candidates: RawPoint[], endCursor: Cursor, ignoreCollisions = false): boolean {
    if (!ignoreCollisions) {
      // Against track already committed, ignoring the run-up to here.
      const horizon = this.grid.count - SELF_CLEARANCE_LOOKBACK;
      for (const c of candidates) {
        if (this.grid.conflicts(c.pos, horizon)) return false;
      }

      // And against the segment's own earlier points. Without this a segment
      // that curls back on itself is accepted, because nothing it overlaps has
      // been committed to the grid yet.
      for (let i = SELF_CLEARANCE_LOOKBACK; i < candidates.length; i++) {
        const here = candidates[i].pos;
        for (let j = 0; j <= i - SELF_CLEARANCE_LOOKBACK; j++) {
          const there = candidates[j].pos;
          const ddx = there.x - here.x;
          const ddz = there.z - here.z;
          if (ddx * ddx + ddz * ddz < MIN_XZ_CLEARANCE * MIN_XZ_CLEARANCE) return false;
        }
      }
    }
    for (const c of candidates) {
      const previous = this.points[this.points.length - 1];
      if (previous) this.advanceSpeed(previous.pos, c.pos);
      this.points.push(c);
      this.grid.add(c.pos);
    }
    this.cursor = { pos: endCursor.pos.clone(), yaw: endCursor.yaw };
    return true;
  }

  /** Seeds the grid with the starting point so nothing loops back onto it. */
  seedStart(width: number): void {
    const p: RawPoint = { pos: this.cursor.pos.clone(), width, gap: false };
    this.points.push(p);
    this.grid.add(p.pos);
  }
}

/**
 * Walks one segment without committing it, returning the points it would add.
 * `yawRate` is radians per horizontal metre; `pitch` is the descent angle.
 */
function walkSegment(
  cursor: Cursor,
  opts: {
    horizontalLength: number;
    pitch: number | ((t: number) => number);
    yawRate: number | ((t: number) => number);
    width: number | ((t: number) => number);
    /** Vertical offset added on top of the descent, for undulating sections. */
    yOffset?: (t: number) => number;
    gapRange?: [number, number];
  },
): { points: RawPoint[]; end: Cursor } {
  const steps = Math.max(2, Math.round(opts.horizontalLength / WALK_STEP));
  const points: RawPoint[] = [];
  let { yaw } = cursor;
  const pos = cursor.pos.clone();
  let previousOffset = 0;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const pitch = typeof opts.pitch === "function" ? opts.pitch(t) : opts.pitch;
    const yawRate = typeof opts.yawRate === "function" ? opts.yawRate(t) : opts.yawRate;
    const width = typeof opts.width === "function" ? opts.width(t) : opts.width;

    yaw += yawRate * WALK_STEP;
    pos.x += Math.cos(yaw) * WALK_STEP;
    pos.z += Math.sin(yaw) * WALK_STEP;
    pos.y -= Math.tan(pitch) * WALK_STEP;

    // Undulation rides on top of the descent, so only apply the delta.
    const offset = opts.yOffset ? opts.yOffset(t) : 0;
    pos.y += offset - previousOffset;
    previousOffset = offset;

    const inGap = opts.gapRange ? t >= opts.gapRange[0] && t <= opts.gapRange[1] : false;
    points.push({ pos: pos.clone(), width, gap: inGap });
  }

  return { points, end: { pos: pos.clone(), yaw } };
}

/**
 * One degree, scaled by the global pitch multiplier.
 *
 * Every gradient in the generator is written in these units, so the whole
 * run's steepness — and therefore how fast marbles end up going — moves with
 * a single number.
 */
const DEG = Math.PI / 180;
function deg(value: number): number {
  return value * DEG * PHYSICS.pitchScale;
}

/** Builds the parameters for one randomly chosen segment kind. */
function rollSegment(
  rng: Rng,
  kind: SegmentKind,
  walker: TrackWalker,
  spinSign: number,
): Parameters<typeof walkSegment>[1] {
  const base = TRACK_CONSTANTS.baseWidth;
  // Steer back toward the middle when the walk drifts to the edge of the arena.
  const drifting = walker.radialDistance > ARENA_RADIUS * 0.6;
  // Otherwise keep turning the same way most of the time. A consistent bias
  // winds the run inward as a flat spiral, which packs a long track into a
  // small footprint without ever crossing itself; an unbiased walk wanders,
  // boxes itself in against its own earlier passes, and has to stop early.
  const preferredSign = drifting
    ? walker.inwardTurnSign
    : rng.chance(0.82)
      ? spinSign
      : -spinSign;

  switch (kind) {
    case "straight": {
      return {
        horizontalLength: rng.range(90, 190),
        pitch: deg(rng.range(4.5, 7)),
        yawRate: 0,
        width: base,
      };
    }
    case "turn": {
      const minRadius = walker.minCornerRadius;
      const radius = Math.max(minRadius, rng.range(14, 40));
      const sweep = rng.range(55, 150) * DEG;
      return {
        horizontalLength: radius * sweep,
        pitch: deg(rng.range(4, 6.5)),
        yawRate: preferredSign / radius,
        width: base * rng.range(1.0, 1.15),
      };
    }
    case "chicane": {
      const radius = Math.max(walker.minCornerRadius * 0.9, rng.range(13, 26));
      const sweep = rng.range(55, 95) * DEG;
      const horizontalLength = radius * sweep * 2;
      return {
        horizontalLength,
        pitch: deg(rng.range(4.5, 7)),
        yawRate: (t) => (t < 0.5 ? preferredSign / radius : -preferredSign / radius),
        width: base,
      };
    }
    case "drop": {
      return {
        horizontalLength: rng.range(18, 34),
        pitch: (t) => deg(rng.range(13, 18)) * Math.min(1, 0.5 + t),
        yawRate: 0,
        width: base * 0.95,
      };
    }
    case "wave": {
      // A rollercoaster undulation, sized so the marble neither takes off over
      // the crests nor has to climb on the way out of the troughs.
      //
      // Two separate limits apply. Following a crest of amplitude A and
      // wavelength λ at speed v needs a downward acceleration of A·(2πv/λ)²,
      // and once that exceeds gravity the marble simply leaves the track at
      // the top. Independently, the wave's own gradient A·2π/λ must stay below
      // the segment's descent, or the back of every trough is an uphill the
      // marble has to climb — which at these speeds stops it dead.
      const length = rng.range(60, 100);
      const cycles = rng.int(2, 3);
      const wavelength = length / cycles;
      const speed = Math.max(20, walker.speed);
      const pitch = rng.range(8, 11);

      const crestLimit =
        (CREST_G_BUDGET * GRAVITY * wavelength * wavelength) /
        (4 * Math.PI * Math.PI * speed * speed);
      // Leave the guaranteed minimum descent intact at the back of a trough.
      const spare = Math.max(0, Math.tan(deg(pitch)) - Math.tan(minimumDescentSlope()));
      const gradientLimit = (spare * WAVE_GRADIENT_BUDGET * wavelength) / (2 * Math.PI);

      const amplitude = Math.min(rng.range(0.8, 2.4), crestLimit, gradientLimit);
      const gentleTurn = rng.chance(0.5) ? preferredSign / rng.range(60, 130) : 0;
      return {
        horizontalLength: length,
        pitch: deg(pitch),
        yawRate: gentleTurn,
        width: base,
        yOffset: (t) => amplitude * Math.sin(t * cycles * Math.PI * 2),
      };
    }
    case "wide": {
      const length = rng.range(50, 80);
      return {
        horizontalLength: length,
        pitch: deg(rng.range(3.5, 5.5)),
        yawRate: rng.chance(0.4) ? preferredSign / rng.range(70, 140) : 0,
        width: (t) => base * (1 + 1.15 * Math.sin(Math.min(1, t) * Math.PI) ** 0.7),
      };
    }
  }
}

/** Resamples the raw walk to an even spacing along its arc length. */
function resample(raw: RawPoint[]): {
  points: Vector3[];
  widths: number[];
  gapFlags: boolean[];
} {
  const cumulative: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    cumulative.push(cumulative[i - 1] + Vector3.Distance(raw[i - 1].pos, raw[i].pos));
  }
  const total = cumulative[cumulative.length - 1];
  const count = Math.max(2, Math.floor(total / POINT_SPACING));

  const points: Vector3[] = [];
  const widths: number[] = [];
  const gapFlags: boolean[] = [];

  let cursor = 0;
  for (let i = 0; i <= count; i++) {
    const target = (i / count) * total;
    while (cursor < raw.length - 2 && cumulative[cursor + 1] < target) cursor++;
    const span = cumulative[cursor + 1] - cumulative[cursor];
    const t = span > 1e-6 ? (target - cumulative[cursor]) / span : 0;
    const a = raw[cursor];
    const b = raw[cursor + 1];
    points.push(Vector3.Lerp(a.pos, b.pos, t));
    widths.push(a.width + (b.width - a.width) * t);
    // A resampled point is a gap if either neighbour was, so gaps never
    // half-close and leave a sliver of floor mid-jump.
    gapFlags.push(a.gap || b.gap);
  }

  return { points, widths, gapFlags };
}

/**
 * Where a raw-walk point sits as a fraction of the walk's total arc length.
 * Used to carry markers (like the finish line) through the resampling step.
 */
function rawDistanceFraction(raw: RawPoint[], index: number): number {
  let cumulative = 0;
  let atIndex = 0;
  for (let i = 1; i < raw.length; i++) {
    cumulative += Vector3.Distance(raw[i - 1].pos, raw[i].pos);
    if (i === index) atIndex = cumulative;
  }
  return cumulative > 1e-6 ? atIndex / cumulative : 1;
}

/**
 * The gentlest gradient at which a marble left at rest will start rolling.
 *
 * A rolling sphere on a slope accelerates at (5/7)·g·sinθ and is retarded by
 * rolling resistance at Crr·g·cosθ, so it only moves off where
 * `tanθ > (7/5)·Crr`. The safety factor covers the marble also having to
 * overcome the walls it may be resting against, and any small irregularity in
 * the swept surface.
 */
function minimumDescentSlope(): number {
  const stationary = (7 / 5) * PHYSICS.rollingResistance;
  return Math.atan(stationary * DESCENT_SAFETY_FACTOR);
}

/**
 * Guarantees the track runs downhill everywhere.
 *
 * Segments are generated with descending gradients, but waves, smoothing and
 * the joins between segments can all conspire to produce a locally flat or
 * rising patch — and a marble that stops on one never starts again. This pass
 * makes the invariant structural rather than something to hope for: after it,
 * every step down the centreline descends by at least the amount a stationary
 * marble needs to get going.
 *
 * Points are only ever moved downward, so nothing rises to meet the marble.
 */
function enforceDescent(points: Vector3[], spacing: number): void {
  const minimumDrop = spacing * Math.tan(minimumDescentSlope());

  const clamp = () => {
    for (let i = 1; i < points.length; i++) {
      const ceiling = points[i - 1].y - minimumDrop;
      if (points[i].y > ceiling) points[i].y = ceiling;
    }
  };

  clamp();
  // A light pass to take the kinks out of anything that had to be pulled down,
  // then re-clamp, since smoothing can lift a point back above its neighbour.
  for (let pass = 0; pass < 3; pass++) {
    const copy = points.map((p) => p.y);
    for (let i = 1; i < points.length - 1; i++) {
      points[i].y = copy[i] * 0.5 + copy[i - 1] * 0.25 + copy[i + 1] * 0.25;
    }
    clamp();
  }
}

/** Light smoothing pass — takes the corners off the segment joins. */
function smooth(points: Vector3[], passes: number, strength = 0.28): void {
  for (let pass = 0; pass < passes; pass++) {
    const copy = points.map((p) => p.clone());
    for (let i = 1; i < points.length - 1; i++) {
      const avg = copy[i - 1].add(copy[i + 1]).scale(0.5);
      points[i] = Vector3.Lerp(copy[i], avg, strength);
    }
  }
}

/**
 * Estimates how fast a marble is travelling at each point on the track.
 *
 * A rolling sphere on a slope accelerates at (5/7)g·sinθ — the 5/7 is the
 * share of energy that goes into translation rather than spin — less rolling
 * and wall losses. Integrating that along the centreline gives a speed profile
 * good enough to size the banking and the walls, which is all it is used for.
 */
function estimateSpeeds(points: Vector3[], maxSpeed: number): number[] {
  const G = GRAVITY;
  const speeds = new Array<number>(points.length).fill(0);
  let vSquared = 0;

  for (let i = 1; i < points.length; i++) {
    const ds = Vector3.Distance(points[i - 1], points[i]);
    const drop = points[i - 1].y - points[i].y;
    vSquared += (10 / 7) * G * drop - 2 * PHYSICS.rollingResistance * G * ds;
    vSquared = Math.max(0.25, Math.min(maxSpeed * maxSpeed, vSquared));
    speeds[i] = Math.sqrt(vSquared);
  }
  speeds[0] = speeds[1] ?? 0;
  return speeds;
}

/** Curvature (1/radius) in the horizontal plane at each point. */
function computeCurvature(points: Vector3[]): { curvature: number[]; sign: number[] } {
  const curvature = new Array<number>(points.length).fill(0);
  const sign = new Array<number>(points.length).fill(0);

  for (let i = 1; i < points.length - 1; i++) {
    const inDir = points[i].subtract(points[i - 1]);
    const outDir = points[i + 1].subtract(points[i]);
    inDir.y = 0;
    outDir.y = 0;
    const lenIn = inDir.length();
    const lenOut = outDir.length();
    if (lenIn < 1e-4 || lenOut < 1e-4) continue;
    inDir.scaleInPlace(1 / lenIn);
    outDir.scaleInPlace(1 / lenOut);

    const cross = inDir.z * outDir.x - inDir.x * outDir.z;
    const dot = Math.max(-1, Math.min(1, Vector3.Dot(inDir, outDir)));
    const turnAngle = Math.atan2(Math.abs(cross), dot);
    // Angle turned per metre travelled is exactly 1/radius.
    curvature[i] = turnAngle / ((lenIn + lenOut) / 2);
    sign[i] = Math.sign(cross);
  }
  return { curvature, sign };
}

function smoothArray(values: number[], passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const copy = values.slice();
    for (let i = 1; i < values.length - 1; i++) {
      values[i] = copy[i] * 0.4 + copy[i - 1] * 0.3 + copy[i + 1] * 0.3;
    }
  }
}

/**
 * Banking is deliberately built to a fraction of the ideal angle.
 *
 * Banking fully for the design speed makes the corner a near-vertical wall,
 * and any marble arriving slower than the model predicted slides into the
 * inside gutter and stops there. Under-banking keeps a floor a slow marble can
 * still roll along, and the wall picks up what the bank gives away.
 */
const BANK_FRACTION = 0.55;
/** Hardest bank the track will build. Beyond this it stops reading as a track. */
const MAX_BANK = 32 * DEG;

/**
 * Banking and wall heights, derived from the cornering forces a marble will
 * actually experience.
 *
 * A corner is banked to the angle at which the marble's own weight supplies
 * the centripetal force it needs, exactly as a velodrome or a bobsleigh track
 * is. Where the required angle exceeds what the track will build, the wall
 * grows instead, so there is always something to hold the marble in. Fixed
 * banking (the earlier approach) left fast corners under-banked, and marbles
 * simply flew out of them.
 */
function computeBanksAndWalls(
  points: Vector3[],
  maxSpeed: number,
  baseWallHeight: number,
): { banks: number[]; wallHeights: number[]; speeds: number[] } {
  const G = GRAVITY;
  const speeds = estimateSpeeds(points, maxSpeed);
  smoothArray(speeds, 4);

  const { curvature, sign } = computeCurvature(points);
  smoothArray(curvature, 6);

  const banks = new Array<number>(points.length).fill(0);
  // Walls are a uniform height everywhere — a plain channel, not a bobsleigh
  // run that grows a lip wherever the maths says it needs one.
  const wallHeights = new Array<number>(points.length).fill(baseWallHeight);

  for (let i = 0; i < points.length; i++) {
    const lateralAccel = speeds[i] * speeds[i] * curvature[i];
    const idealBank = Math.atan(lateralAccel / G);
    banks[i] = Math.min(MAX_BANK, idealBank * BANK_FRACTION) * (sign[i] || 0);
  }

  // Smooth both so the swept surface never twists or steps abruptly.
  smoothArray(banks, 10);
  smoothArray(wallHeights, 8);

  return { banks, wallHeights, speeds };
}

/** Turns the gap flags into index ranges. */
function collectGaps(gapFlags: boolean[]): GapSpec[] {
  const gaps: GapSpec[] = [];
  let start = -1;
  for (let i = 0; i < gapFlags.length; i++) {
    if (gapFlags[i] && start < 0) start = i;
    if (!gapFlags[i] && start >= 0) {
      gaps.push({ startIndex: start, endIndex: i - 1 });
      start = -1;
    }
  }
  if (start >= 0) gaps.push({ startIndex: start, endIndex: gapFlags.length - 1 });
  return gaps;
}

const OBSTACLE_KINDS: ObstacleKind[] = ["pins", "wedge", "baffles", "posts", "divider"];

/** Places hazards along the finished centreline. */
function placeObstacles(
  rng: Rng,
  points: Vector3[],
  widths: number[],
  banks: number[],
  gaps: GapSpec[],
  startIndex: number,
  finishIndex: number,
): ObstacleSpec[] {
  const obstacles: ObstacleSpec[] = [];
  const blocked = new Uint8Array(points.length);

  // Never place anything in a jump gap, on its ramps, or near the ends.
  const block = (from: number, to: number) => {
    for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) blocked[i] = 1;
  };
  block(0, startIndex + 20);
  block(finishIndex - 14, points.length - 1);
  for (const gap of gaps) block(gap.startIndex - 12, gap.endIndex + 12);

  // Roughly one feature per metre. Denser than this and the run stops being a
  // marble run with obstacles on it and becomes an obstacle course: marbles
  // never recover their speed between hits, and the field jams solid.
  const minSpacing = 55; // in points, ~66 cm
  let index = startIndex + rng.int(30, 60);

  while (index < finishIndex - 20) {
    const straightness = 1 - Math.min(1, Math.abs(banks[index]) / (24 * DEG));
    const roomy = widths[index] / TRACK_CONSTANTS.baseWidth;

    // Weight the choice by what the track is doing here: pegs and dividers want
    // width, spinners and gates want a reasonably straight run at them.
    // Wide stretches suit the patterns that need room; anything narrow gets
    // the obstacles that only need a lane either side.
    const weights = OBSTACLE_KINDS.map((kind) => {
      switch (kind) {
        case "pins":
          return roomy > 1.4 ? 3.0 : 1.2;
        case "wedge":
          return straightness * 1.6 + 0.4;
        case "baffles":
          // Kept rare on purpose: of the static obstacles this is the one
          // marbles most often come to rest against.
          return straightness * 0.7 + 0.1;
        case "posts":
          return 1.2;
        case "divider":
          return roomy > 1.3 ? 1.4 : 0.4;
      }
    });

    if (!blocked[index]) {
      const kind = rng.weighted(OBSTACLE_KINDS, weights);
      obstacles.push({ kind, index, params: rollObstacleParams(rng, kind) });
      block(index - 8, index + 8);
    }

    index += minSpacing + rng.int(0, 55);
  }

  return obstacles;
}

function rollObstacleParams(rng: Rng, kind: ObstacleKind): Record<string, number> {
  switch (kind) {
    case "pins":
      return {
        // Below 0.5 a bowling triangle, above it a square grid.
        pattern: rng.next(),
        rows: rng.int(3, 5),
        columns: rng.int(2, 4),
      };
    case "wedge":
      return { offset: rng.range(-0.5, 0.5) };
    case "baffles":
      return { count: rng.int(2, 4) };
    case "posts":
      return { count: rng.int(2, 4), spread: rng.range(0.45, 0.8) };
    case "divider":
      return { length: rng.range(22, 44), offset: rng.range(-0.1, 0.1) };
  }
}

const HIGHLIGHT_LABELS: Record<ObstacleKind, string> = {
  pins: "Pin field",
  wedge: "Splitters",
  baffles: "Weave",
  posts: "Posts",
  divider: "Split lanes",
};

/**
 * Builds a complete, deterministic track plan for the given seed.
 */
export function generateTrack(seedText: string): TrackPlan {
  const rng = new Rng(seedText);

  // Which way this run winds, and where it starts.
  //
  // It begins out at the edge of the arena heading along the rim, not in the
  // middle: a run started at the centre has its own earlier passes on every
  // side within a few segments and quickly has nowhere left to go, which cut
  // tracks short. From the rim it can work its way inward across open ground.
  const spinSign = rng.chance(0.5) ? 1 : -1;
  const startAngle = rng.range(0, Math.PI * 2);
  const startRadius = ARENA_RADIUS * 0.86;
  const walker = new TrackWalker(
    new Vector3(Math.cos(startAngle) * startRadius, 0, Math.sin(startAngle) * startRadius),
    startAngle + (spinSign * Math.PI) / 2,
  );
  walker.seedStart(TRACK_CONSTANTS.baseWidth);

  // --- Start gate: a short flat shelf, then the launch ramp. -----------------
  {
    const flat = walkSegment(walker.cursor, {
      horizontalLength: 16,
      pitch: deg(1.5),
      yawRate: 0,
      width: TRACK_CONSTANTS.baseWidth * 1.9,
    });
    walker.tryAppend(flat.points, flat.end, true);

    const launch = walkSegment(walker.cursor, {
      horizontalLength: 34,
      pitch: (t) => deg(5 + 8 * t),
      yawRate: 0,
      width: (t) => TRACK_CONSTANTS.baseWidth * (1.9 - 0.75 * t),
    });
    walker.tryAppend(launch.points, launch.end, true);
  }

  // --- Body: keep adding segments until we have enough run. ------------------
  const targetLength = rng.range(1500, 2000);
  const kinds = Object.keys(SEGMENT_WEIGHTS) as SegmentKind[];
  const weights = kinds.map((k) => SEGMENT_WEIGHTS[k]);
  const used: SegmentKind[] = [];
  let travelled = 0;
  let lastKind: SegmentKind | null = null;
  let guard = 0;

  while (travelled < targetLength && guard++ < 600) {
    // Don't repeat a segment kind back to back — variety reads better.
    let kind = rng.weighted(kinds, weights);
    if (kind === lastKind) kind = rng.weighted(kinds, weights);

    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      const opts = rollSegment(rng, kind, walker, spinSign);
      const seg = walkSegment(walker.cursor, opts);
      if (walker.tryAppend(seg.points, seg.end)) {
        travelled += opts.horizontalLength;
        used.push(kind);
        lastKind = kind;
        placed = true;
      }
    }

    if (!placed) {
      // Cornered. A hairpin turns the run back on itself and carries on
      // across new ground — the same trick a mountain road uses to lose
      // height without crossing over itself. The old escape was a descending
      // helix, which only works if the run is allowed to stack.
      let escaped = false;
      for (let attempt = 0; attempt < 10 && !escaped; attempt++) {
        // Wide enough that the two legs of the hairpin clear each other.
        const radius = Math.max(
          walker.minCornerRadius,
          MIN_XZ_CLEARANCE * 0.62 + attempt * 4,
        );
        const sign =
          walker.radialDistance > ARENA_RADIUS * 0.5 ? walker.inwardTurnSign : spinSign;
        const sweep = rng.range(150, 200) * DEG;
        const hairpin = walkSegment(walker.cursor, {
          horizontalLength: radius * sweep,
          pitch: deg(6 + attempt * 0.6),
          yawRate: sign / radius,
          width: TRACK_CONSTANTS.baseWidth,
        });
        if (walker.tryAppend(hairpin.points, hairpin.end)) {
          travelled += hairpin.points.length * WALK_STEP;
          used.push("turn");
          lastKind = "turn";
          escaped = true;
        }
      }

      // Genuinely nowhere left to go. A shorter run is better than one that
      // passes through itself, so stop here and head for the finish.
      if (!escaped) break;
    }
  }

  // --- Finish -----------------------------------------------------------------
  // The finish straight keeps a real gradient right through the line. An
  // earlier version flattened out on the approach, and marbles routinely ran
  // out of energy a few metres short and sat there forever.
  const finishStraight = walkSegment(walker.cursor, {
    horizontalLength: 75,
    pitch: deg(5.5),
    yawRate: 0,
    width: (t) => TRACK_CONSTANTS.baseWidth * (1 + 0.8 * Math.min(1, t * 1.4)),
  });
  walker.tryAppend(finishStraight.points, finishStraight.end, true);

  // Everything past this point is run-off, not race track.
  const finishRawIndex = walker.points.length - 1;

  // Catch basin: flattens, then tips slightly uphill so marbles settle instead
  // of shooting off the end.
  // Run-off past the line. It stays downhill like everything else — marbles
  // are stopped by the end wall of the basin, not by an upslope.
  const basin = walkSegment(walker.cursor, {
    horizontalLength: 55,
    pitch: deg(3),
    yawRate: 0,
    width: (t) => TRACK_CONSTANTS.baseWidth * (1.8 + 0.5 * t),
  });
  walker.tryAppend(basin.points, basin.end, true);

  // --- Resample, smooth, and derive everything else. -------------------------
  const { points, widths, gapFlags } = resample(walker.points);
  smooth(points, 6, 0.3);
  enforceDescent(points, POINT_SPACING);

  const { banks, wallHeights, speeds } = computeBanksAndWalls(
    points,
    MAX_MARBLE_SPEED,
    TRACK_CONSTANTS.wallHeight,
  );
  const gaps = collectGaps(gapFlags);

  // Recompute distances after smoothing so progress tracking stays honest.
  const finalDistances = [0];
  for (let i = 1; i < points.length; i++) {
    finalDistances.push(finalDistances[i - 1] + Vector3.Distance(points[i - 1], points[i]));
  }

  const startIndex = Math.min(4, points.length - 1);
  // Map the finish marker from raw-walk space into resampled space. Both are
  // parameterised by arc length, so the fraction carries across directly.
  const finishIndex = Math.max(
    startIndex + 1,
    Math.min(
      points.length - 2,
      Math.round(rawDistanceFraction(walker.points, finishRawIndex) * (points.length - 1)),
    ),
  );

  const obstacles = placeObstacles(
    rng,
    points,
    widths,
    banks,
    gaps,
    startIndex,
    finishIndex,
  );

  const highlights: string[] = [];
  const seen = new Set<string>();
  for (const o of obstacles) {
    const label = HIGHLIGHT_LABELS[o.kind];
    if (!seen.has(label)) {
      seen.add(label);
      highlights.push(label);
    }
  }
  if (used.includes("wave")) highlights.unshift("Rollercoaster");
  if (used.includes("drop")) highlights.unshift("Steep drops");

  return {
    seed: seedText,
    points,
    widths,
    banks,
    wallHeights,
    estimatedSpeeds: speeds,
    gaps,
    obstacles,
    distances: finalDistances,
    totalLength: finalDistances[finalDistances.length - 1],
    startIndex,
    finishIndex,
    totalDrop: points[0].y - points[finishIndex].y,
    segments: used,
    highlights: highlights.slice(0, 6),
  };
}
