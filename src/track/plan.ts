import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Scale and physical constants for the run.
 *
 * ## Units
 *
 * One world unit is one centimetre, and gravity is set to 981 u/s² to match.
 * That is a pure change of units — the physics is identical to working in
 * metres — but it keeps every number the engine sees in a comfortable range.
 * Modelling a 16mm marble as a 0.008-unit sphere would put it below the
 * tolerances a rigid-body solver is built around; at 0.8 units it is
 * unremarkable.
 *
 * ## Why this scale
 *
 * A rolling sphere that has descended a height h is travelling at
 * `v = √(2·g·h·5/7)`. Top speed therefore follows from the total drop and
 * nothing else — not from the track's length, and not from how big the
 * marbles are. Wanting marbles to potter along at around 1 m/s is really
 * wanting a run that only ever drops half a metre, which is to say a real
 * marble run on a table rather than a fairground ride.
 */

/** World units per metre. One unit is a centimetre. */
export const UNITS_PER_METRE = 100;

/** Gravity, in world units per second squared. */
export const GRAVITY = 9.81 * UNITS_PER_METRE;

/** Converts world units per second into metres per second, for display. */
export function toMetresPerSecond(unitsPerSecond: number): number {
  return unitsPerSecond / UNITS_PER_METRE;
}

/**
 * Ceiling on marble speed, in units per second (1 m/s).
 *
 * Approached rather than clamped: a drag term ramps up steeply near it, so
 * marbles settle around it the way air resistance would, instead of hitting an
 * obviously artificial wall. It also keeps a marble from moving further in one
 * physics step than the track shell is thick, which is what would let one pass
 * straight through the floor.
 */
export const MAX_MARBLE_SPEED = 1.0 * UNITS_PER_METRE;

/**
 * The two numbers that between them set how fast the run flows.
 *
 * `rollingResistance` is the combined rolling and wall-rub loss as a fraction
 * of weight — a little higher than a glass marble on a glass plate (~0.02),
 * because a marble in a channel is also rubbing its walls. A marble only
 * accelerates where the slope exceeds `atan(1.4 · rollingResistance)`, so this
 * also sets the gentlest gradient the track can get away with.
 *
 * `pitchScale` multiplies every gradient the generator produces.
 *
 * They pull against each other — more resistance means the track has to be
 * steeper to keep marbles moving at all, and a steeper track makes them
 * faster — so they were chosen together, by sweeping the pair and reading off
 * the resulting flow speeds and stall rates. See scripts/flow-sweep.mjs.
 */
export const PHYSICS = {
  rollingResistance: 0.018,
  pitchScale: 0.75,
};

/** Kinds of hazard the generator can sprinkle along a run. */
export type ObstacleKind =
  | "spinner" // rotating cross-paddle sweeping the channel
  | "pendulum" // hammer swinging across the track
  | "pegs" // pachinko field in a widened section
  | "bumpers" // bouncy posts that fling marbles sideways
  | "gate" // flipping barrier that opens and closes on a cycle
  | "boost" // ramp kicker that speeds marbles up
  | "divider" // island splitting the channel into two lanes
  | "drum" // rotating barrel with cut-out slots
  | "fan"; // crosswind zone pushing marbles to one side

export interface ObstacleSpec {
  kind: ObstacleKind;
  /** Index into the resampled centreline where this sits. */
  index: number;
  /** Deterministic per-obstacle parameters, meaning depends on `kind`. */
  params: Record<string, number>;
}

/** A stretch of missing floor — the marbles have to fly it. */
export interface GapSpec {
  startIndex: number;
  endIndex: number;
}

export interface TrackPlan {
  seed: string;
  /** Uniformly spaced centreline, from start gate to catch basin. */
  points: Vector3[];
  /** Channel half-width at each point, in world units. */
  widths: number[];
  /** Banking at each point (radians, positive = right side raised). */
  banks: number[];
  /** Wall height at each point — corners get a little more than straights. */
  wallHeights: number[];
  /** Modelled marble speed at each point, units/s. */
  estimatedSpeeds: number[];
  gaps: GapSpec[];
  obstacles: ObstacleSpec[];
  /** Arc length at each point, world units. */
  distances: number[];
  totalLength: number;
  /** Index at which the marbles are released. */
  startIndex: number;
  /** Index of the finish line. */
  finishIndex: number;
  /** Vertical drop from start to finish, world units. */
  totalDrop: number;
  /** The segment kinds the generator laid down, in order. */
  segments: string[];
  /** Human-readable list of what this track threw in, for the setup screen. */
  highlights: string[];
}

/**
 * Spacing of the resampled centreline, in world units (1.2 cm).
 *
 * This is also the length of a mesh facet along the track. A 16mm marble
 * rolling over 2cm facets can feel each edge; at 1.2cm the surface reads as
 * smooth to it.
 */
export const POINT_SPACING = 1.2;

/**
 * Dimensions of the run, in centimetres.
 *
 * These describe a large but entirely ordinary wooden marble run: a 16mm
 * glass marble in a channel a little over 5cm wide, with the whole thing
 * standing about half a metre tall.
 */
export const TRACK_CONSTANTS = {
  /** Radius of a 16mm glass marble. */
  marbleRadius: 0.8,
  /**
   * Default channel half-width — about four and a half marbles across.
   *
   * Sized for a field of racers rather than for one marble. A channel just
   * wide enough for three left six marbles jamming solid behind every gate
   * and spinner, because none of them could get past another.
   */
  baseWidth: 3.6,
  /**
   * How far the side walls rise above the channel floor — nearly two and a
   * half marble diameters. A deep open channel, rather than a shallow one
   * with an overhanging lip: it contains marbles just as well and leaves the
   * race visible from every angle.
   */
  wallHeight: 4.4,
  /**
   * Thickness of the track shell.
   *
   * Sized against the distance a marble covers between collision checks. At
   * 1.4 m/s and a 1/240s step that is 0.6cm, so anything thinner than this
   * lets a marble arriving fast off a jump punch straight through the floor.
   */
  shellThickness: 1.2,
  /** Radius of the rounded floor of the channel. */
  filletRadius: 1.8,
  /**
   * The rounded top edge of the wall, as a fraction of the local half-width,
   * and how far round it turns. At 90° this is a finished rim with no
   * overhang, which is what an open channel wants: at these speeds marbles
   * have no tendency to climb the walls, so there is nothing to catch.
   */
  lipFraction: 0.26,
  lipMaxRadius: 1.2,
  lipSweepDegrees: 90,
};
