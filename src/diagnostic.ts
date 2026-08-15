/**
 * Tuning harness.
 *
 * Runs races headlessly — no rendering at all — across many seeds and reports
 * how they went: did everyone finish, how long did it take, how often did
 * marbles need rescuing, and where on the track did they come unstuck.
 *
 * This exists because the interesting failures in a physics race are
 * statistical. One race looking fine says very little; a hundred races
 * agreeing that obstacle X strands a third of the field says a lot.
 *
 * Open /diagnostic.html and call `runDiagnostic({ seeds: 40 })` from the
 * console, or let scripts/tune.mjs drive it.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { World, initPhysics } from "./game/world";
import { makePlayers } from "./ui/players";
import { FIXED_STEP } from "./game/race";
import { PHYSICS, TRACK_CONSTANTS, UNITS_PER_METRE, toMetresPerSecond } from "./track/plan";

export interface SeedReport {
  seed: string;
  trackLength: number;
  totalDrop: number;
  obstacles: number;
  gaps: number;
  /** How many of the field reached the finish line. */
  finishers: number;
  fieldSize: number;
  winnerTime: number | null;
  lastFinishTime: number | null;
  totalRescues: number;
  /** Centreline indices, as a fraction of track length, where rescues happened. */
  rescuePoints: number[];
  /** Where non-finishers ended up, as a fraction of the track. */
  strandedAt: number[];
  /** Nearest obstacle to each stranded marble, if any is close enough to blame. */
  strandedNear: string[];
  /** Nearest obstacle to each rescue, tallied by kind. */
  rescuesByObstacle: Record<string, number>;
  /** What triggered each rescue, tallied by reason. */
  rescuesByReason: Record<string, number>;
  /** How far outside the channel each off-track rescue happened. */
  offTrackLateral: number[];
  offTrackVertical: number[];
  offTrackInGap: number;
  /** How each marble left the channel: sideways vs vertical, and how fast. */
  departures: Array<{ side: number; up: number; speed: number; width: number; wall: number }>;
  /** Mean and peak marble speed over the race, m/s. */
  meanSpeed: number;
  peakSpeed: number;
  simSeconds: number;
  buildMs: number;
  simMs: number;
}

export interface DiagnosticOptions {
  seeds?: number;
  players?: number;
  /** Give up on a race after this much simulated time. */
  maxSimSeconds?: number;
  seedPrefix?: string;
  disableObstacles?: boolean;
  maxSpeed?: number;
  /** Overrides the channel lip geometry, for tuning sweeps. */
  lipFraction?: number;
  lipSweepDegrees?: number;
  baseWidth?: number;
  rollingResistance?: number;
  pitchScale?: number;
}

/** Runs one race to completion with no rendering, as fast as the CPU allows. */
export async function runSeed(
  seed: string,
  playerCount: number,
  maxSimSeconds: number,
  knobs: { disableObstacles?: boolean; maxSpeed?: number } = {},
): Promise<SeedReport> {
  const names = Array.from({ length: playerCount }, (_, i) => `P${i + 1}`);

  const buildStart = performance.now();
  const rescuePoints: number[] = [];
  const rescueIndices: number[] = [];
  const rescuesByReason: Record<string, number> = {};
  const offTrackLateral: number[] = [];
  const offTrackVertical: number[] = [];
  let offTrackInGap = 0;
  const departures: SeedReport["departures"] = [];

  const world = new World({
    canvas: null,
    seed,
    players: makePlayers(names),
    headless: true,
    disableObstacles: knobs.disableObstacles,
    maxSpeed: knobs.maxSpeed,
    events: {
      onRescue: (marble, reason) => {
        rescuePoints.push(marble.progressIndex / world.geometry.frames.length);
        rescueIndices.push(marble.progressIndex);
        rescuesByReason[reason] = (rescuesByReason[reason] ?? 0) + 1;
        if (reason === "off-track") {
          offTrackLateral.push(marble.lastLateral);
          offTrackVertical.push(marble.lastVertical);
          if (marble.lastInGap) offTrackInGap++;
          departures.push({
            side: marble.departureSide,
            up: marble.departureUp,
            speed: marble.departureSpeed,
            width: marble.departureWidth,
            wall: marble.departureWall,
          });
        }
      },
    },
  });
  const buildMs = performance.now() - buildStart;
  // Handy when inspecting a single track from the console.
  (window as unknown as { __lastPlan?: unknown }).__lastPlan = {
    segments: world.plan.segments,
    gaps: world.plan.gaps.length,
    length: world.plan.totalLength,
    drop: world.plan.totalDrop,
  };

  const physicsEngine = world.scene.getPhysicsEngine();
  const plugin = physicsEngine?.getPhysicsPlugin();
  const bodies = physicsEngine && "getBodies" in physicsEngine
    ? (physicsEngine as { getBodies(): unknown[] }).getBodies()
    : [];

  world.startCountdown(0.25);

  const simStart = performance.now();
  const maxSteps = Math.ceil(maxSimSeconds / FIXED_STEP);
  let steps = 0;

  while (world.race.isRunning() && steps < maxSteps) {
    world.scene.onBeforePhysicsObservable.notifyObservers(world.scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (plugin as any)?.executeStep(FIXED_STEP, bodies);
    world.scene.onAfterPhysicsObservable.notifyObservers(world.scene);
    steps++;
  }

  const simMs = performance.now() - simStart;
  if (world.race.isRunning()) world.race.forceComplete();

  const standings = world.race.getStandings();
  const finished = standings.filter((s) => s.marble.finished);

  /** Names the obstacle nearest a centreline index, or "open track". */
  const blame = (index: number, window = 12): string => {
    let best: string | null = null;
    let bestDistance = window;
    for (const obstacle of world.plan.obstacles) {
      const distance = Math.abs(obstacle.index - index);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = obstacle.kind;
      }
    }
    for (const gap of world.plan.gaps) {
      const distance = Math.min(
        Math.abs(gap.startIndex - index),
        Math.abs(gap.endIndex - index),
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = "jump";
      }
    }
    if (index >= world.plan.finishIndex - 12) return "finish";
    return best ?? "open track";
  };

  const rescuesByObstacle: Record<string, number> = {};
  for (const index of rescueIndices) {
    const kind = blame(index);
    rescuesByObstacle[kind] = (rescuesByObstacle[kind] ?? 0) + 1;
  }

  const report: SeedReport = {
    seed,
    trackLength: world.plan.totalLength / UNITS_PER_METRE,
    totalDrop: world.plan.totalDrop / UNITS_PER_METRE,
    obstacles: world.plan.obstacles.length,
    gaps: world.plan.gaps.length,
    finishers: finished.length,
    fieldSize: standings.length,
    winnerTime: finished[0]?.marble.finishTime ?? null,
    lastFinishTime: finished[finished.length - 1]?.marble.finishTime ?? null,
    totalRescues: standings.reduce((sum, s) => sum + s.marble.rescues, 0),
    rescuePoints,
    strandedAt: standings.filter((s) => !s.marble.finished).map((s) => s.progress),
    strandedNear: standings
      .filter((s) => !s.marble.finished)
      .map((s) => blame(s.marble.progressIndex)),
    rescuesByObstacle,
    rescuesByReason,
    offTrackLateral,
    offTrackVertical,
    offTrackInGap,
    departures,
    meanSpeed: toMetresPerSecond(
      standings.reduce(
        (sum, s) => sum + (s.marble.speedSamples ? s.marble.speedSum / s.marble.speedSamples : 0),
        0,
      ) / Math.max(1, standings.length),
    ),
    peakSpeed: toMetresPerSecond(Math.max(...standings.map((s) => s.marble.peakSpeed), 0)),
    simSeconds: world.race.simTime,
    buildMs,
    simMs,
  };

  world.dispose();
  return report;
}

export async function runDiagnostic(options: DiagnosticOptions = {}): Promise<{
  reports: SeedReport[];
  summary: Record<string, number>;
}> {
  const {
    seeds = 25,
    players = 6,
    maxSimSeconds = 240,
    seedPrefix = "TUNE",
    disableObstacles,
    maxSpeed,
    lipFraction,
    lipSweepDegrees,
    baseWidth,
    rollingResistance,
    pitchScale,
  } = options;

  const saved = {
    fraction: TRACK_CONSTANTS.lipFraction,
    sweep: TRACK_CONSTANTS.lipSweepDegrees,
    width: TRACK_CONSTANTS.baseWidth,
  };
  if (lipFraction !== undefined) TRACK_CONSTANTS.lipFraction = lipFraction;
  if (lipSweepDegrees !== undefined) TRACK_CONSTANTS.lipSweepDegrees = lipSweepDegrees;
  if (baseWidth !== undefined) TRACK_CONSTANTS.baseWidth = baseWidth;
  const savedPhysics = { ...PHYSICS };
  if (rollingResistance !== undefined) PHYSICS.rollingResistance = rollingResistance;
  if (pitchScale !== undefined) PHYSICS.pitchScale = pitchScale;

  await initPhysics();

  const reports: SeedReport[] = [];
  for (let i = 0; i < seeds; i++) {
    reports.push(
      await runSeed(`${seedPrefix}-${i}`, players, maxSimSeconds, { disableObstacles, maxSpeed }),
    );
  }

  TRACK_CONSTANTS.lipFraction = saved.fraction;
  TRACK_CONSTANTS.lipSweepDegrees = saved.sweep;
  TRACK_CONSTANTS.baseWidth = saved.width;
  Object.assign(PHYSICS, savedPhysics);

  const totalMarbles = reports.reduce((s, r) => s + r.fieldSize, 0);
  const totalFinishers = reports.reduce((s, r) => s + r.finishers, 0);
  const complete = reports.filter((r) => r.finishers === r.fieldSize);
  const winnerTimes = reports.map((r) => r.winnerTime).filter((t): t is number => t !== null);

  const summary = {
    seeds: reports.length,
    finishRate: totalFinishers / Math.max(1, totalMarbles),
    racesWhereEveryoneFinished: complete.length / Math.max(1, reports.length),
    medianWinnerTime: median(winnerTimes),
    minWinnerTime: winnerTimes.length ? Math.min(...winnerTimes) : 0,
    maxWinnerTime: winnerTimes.length ? Math.max(...winnerTimes) : 0,
    meanRescuesPerRace: reports.reduce((s, r) => s + r.totalRescues, 0) / Math.max(1, reports.length),
    meanTrackLength: mean(reports.map((r) => r.trackLength)),
    meanDrop: mean(reports.map((r) => r.totalDrop)),
    meanSpeed: mean(reports.map((r) => r.meanSpeed)),
    peakSpeed: Math.max(...reports.map((r) => r.peakSpeed)),
    meanBuildMs: mean(reports.map((r) => r.buildMs)),
    meanSimMs: mean(reports.map((r) => r.simMs)),
  };

  return { reports, summary };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The at-rest test.
 *
 * Places a single marble, stationary, at points all along the track and gives
 * it a couple of seconds to move off. Every one of them should be rolling
 * towards the finish. This is the direct check of the invariant that the run
 * is downhill everywhere — geometry alone cannot prove it, because a marble
 * also has to overcome the channel walls and the faceting of the swept
 * surface.
 */
export async function restTest(
  seed: string,
  samples = 40,
  settleSeconds = 2.5,
): Promise<{
  seed: string;
  tested: number;
  rolled: number;
  /** Fractions along the track where the marble failed to move off. */
  stuckAt: number[];
  /** What was at each of those points — an obstacle, a jump, or open track. */
  stuckOn: string[];
  /** Slowest speed reached at any tested point, m/s. */
  slowest: number;
  minSlopeDegrees: number;
  risingPoints: number;
}> {
  await initPhysics();

  const world = new World({
    canvas: null,
    seed,
    players: makePlayers(["Probe"]),
    headless: true,
  });

  const { geometry, plan } = world;
  const marble = world.race.marbles[0];

  // Pure geometry check first: does the centreline ever fail to descend?
  let minSlope = Infinity;
  let risingPoints = 0;
  for (let i = 1; i <= plan.finishIndex; i++) {
    const drop = plan.points[i - 1].y - plan.points[i].y;
    const run = Vector3.Distance(plan.points[i - 1], plan.points[i]);
    if (run < 1e-6) continue;
    const slope = Math.asin(Math.max(-1, Math.min(1, drop / run)));
    if (slope < minSlope) minSlope = slope;
    if (drop <= 0) risingPoints++;
  }

  const physicsEngine = world.scene.getPhysicsEngine();
  const plugin = physicsEngine?.getPhysicsPlugin();
  const bodies = physicsEngine && "getBodies" in physicsEngine
    ? (physicsEngine as { getBodies(): unknown[] }).getBodies()
    : [];

  // Run under real race conditions — rolling resistance applied, obstacles
  // turning — but in probe mode, so a stuck probe stays stuck instead of being
  // rescued into a false pass.
  world.race.probeMode = true;
  world.startCountdown(0);
  world.scene.onBeforePhysicsObservable.notifyObservers(world.scene);
  marble.release();

  const stuckAt: number[] = [];
  const stuckOn: string[] = [];
  let slowest = Infinity;
  let rolled = 0;

  /** Names whatever sits at a centreline index. */
  const whatIsHere = (index: number, window = 10): string => {
    for (const gap of plan.gaps) {
      if (index >= gap.startIndex - window && index <= gap.endIndex + window) return "jump";
    }
    let best = "open track";
    let bestDistance = window;
    for (const obstacle of plan.obstacles) {
      const distance = Math.abs(obstacle.index - index);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = obstacle.kind;
      }
    }
    return best;
  };

  const steps = Math.ceil(settleSeconds / FIXED_STEP);
  for (let sample = 0; sample < samples; sample++) {
    const fraction = (sample + 0.5) / samples;
    const index = fraction * plan.finishIndex;
    const frame = geometry.frameAt(index);

    marble.teleport(frame.position.add(frame.up.scale(TRACK_CONSTANTS.marbleRadius * 1.05)));
    // Reset the progress tracking for this sample. Distance travelled is read
    // from the race's own incremental tracker rather than recomputed at the
    // end: a marble that rolls well away lands outside any sensible
    // nearest-point search window, and would be scored as stuck.
    marble.progressIndex = index;
    const startDistance = geometry.distanceAtIndex(index);
    marble.distance = startDistance;
    marble.bestDistance = startDistance;
    marble.progressWatermark = startDistance;

    let peak = 0;
    for (let step = 0; step < steps; step++) {
      world.scene.onBeforePhysicsObservable.notifyObservers(world.scene);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (plugin as any)?.executeStep(FIXED_STEP, bodies);
      world.scene.onAfterPhysicsObservable.notifyObservers(world.scene);
      peak = Math.max(peak, marble.velocity.length());
    }

    const moved = marble.bestDistance - startDistance;

    // Rolling towards the finish means real forward progress, not a wobble.
    if (moved > TRACK_CONSTANTS.marbleRadius * 4) {
      rolled++;
    } else {
      stuckAt.push(fraction);
      stuckOn.push(whatIsHere(index));
    }
    slowest = Math.min(slowest, toMetresPerSecond(peak));
  }

  world.dispose();

  return {
    seed,
    tested: samples,
    rolled,
    stuckAt,
    stuckOn,
    slowest,
    minSlopeDegrees: (minSlope * 180) / Math.PI,
    risingPoints,
  };
}

declare global {
  interface Window {
    runDiagnostic: typeof runDiagnostic;
    runSeed: typeof runSeed;
    restTest: typeof restTest;
  }
}

window.runDiagnostic = runDiagnostic;
window.runSeed = runSeed;
window.restTest = restTest;
