import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { TrackGeometry } from "../track/geometry";
import type { ForceZone } from "../track/obstacles";
import { Marble, type Player } from "./marble";
import {
  GRAVITY,
  MAX_MARBLE_SPEED,
  PHYSICS,
  TRACK_CONSTANTS,
  UNITS_PER_METRE,
} from "../track/plan";

/**
 * The race itself: stepping the simulation at a fixed rate, tracking who is
 * where, rescuing marbles that get themselves into trouble, and deciding the
 * finishing order.
 *
 * Everything here is driven by simulated time, never by wall-clock time, so a
 * given seed produces the same race whether it renders at 120fps or 24.
 */

/**
 * Physics step.
 *
 * Collision detection is discrete, so what matters is how far a marble travels
 * per step relative to its own radius. A 16mm marble at 1.4 m/s covers 1.2cm
 * per 1/120s step — half as much again as its radius, which is enough to skip
 * through the floor. At 1/240 it covers 0.6cm, comfortably inside it.
 */
export const FIXED_STEP = 1 / 240;

/** Above this, the marbles are moving too fast to collide reliably. */
const DEFAULT_MAX_SPEED = MAX_MARBLE_SPEED;
/**
 * How far outside its own channel a marble may stray before it counts as
 * having left the track, as a multiple of marble radius.
 *
 * Measured against the local cross-section rather than as a fixed distance
 * from the centreline. A fixed radius cannot work: the channel is more than
 * twice as wide in the pachinko sections as on a straight, so any radius
 * generous enough for the wide parts ignores real departures on the narrow
 * ones, and any radius tight enough for the narrow parts flags marbles that
 * are sitting perfectly happily against a wall in a wide one.
 */
const OFF_TRACK_MARGIN = 3.5;
const OFF_TRACK_GRACE = 1.1;
/** A marble this slow for this long is stuck on something (5 cm/s). */
const STALL_SPEED = 5;
const STALL_NUDGE_AFTER = 2.5;
const STALL_RESCUE_AFTER = 6.0;
/**
 * A marble can be moving briskly and still be going nowhere — pinballing
 * between bumpers, orbiting a bowl, or rolling back and forth in a dip. The
 * stall check never fires on those, so progress itself is watched separately.
 *
 * Generous, because waiting a turn behind a closed gate is legitimate racing,
 * not a fault, and teleporting a marble out of a queue looks like cheating.
 */
const NO_PROGRESS_RESCUE_AFTER = 11.0;
/** Progress smaller than this doesn't count as getting anywhere, in cm. */
const PROGRESS_EPSILON = 4;
/** Once the leader finishes, stragglers get this long before being timed out. */
const STRAGGLER_GRACE = 25;
/** How long a finisher keeps rolling before it is lifted off the track. */
const RETIRE_DELAY = 2.2;
/**
 * Hard ceiling on a race. Nothing should ever reach this, but a race that
 * cannot end is worse than one that ends untidily, so there is always a floor
 * under the failure mode.
 */
const MAX_RACE_SECONDS = 200;
/**
 * Two rescues within this many centreline points count as the same trouble
 * spot, and the next attempt lifts the marble past it rather than back into it.
 */
const REPEAT_RESCUE_WINDOW = 14;

export type RaceState = "ready" | "countdown" | "racing" | "finished";

export interface Standing {
  marble: Marble;
  place: number;
  progress: number; // 0..1 along the track
  gapToLeader: number; // metres
}

/** Why a marble had to be put back on the track. */
export type RescueReason = "off-track" | "no-progress" | "stalled";

export interface RaceEvents {
  onCountdownTick?(secondsLeft: number): void;
  onStart?(): void;
  onFinish?(marble: Marble, place: number): void;
  onRaceComplete?(standings: Standing[]): void;
  onRescue?(marble: Marble, reason: RescueReason): void;
}

export class Race {
  readonly marbles: Marble[] = [];
  state: RaceState = "ready";
  /** Simulated seconds since the gate opened. Negative during the countdown. */
  simTime = 0;
  private countdownRemaining = 3;
  private lastCountdownAnnounced = 4;
  /**
   * Diagnostic probe mode, used by the at-rest test in the tuning harness.
   *
   * Suspends the three things that would interfere with a probe: recovery
   * (which would teleport a stuck probe away and turn a failure into a pass),
   * finishing (which stops progress being tracked), and retiring (which
   * disposes the physics body, breaking every later sample).
   */
  probeMode = false;
  private firstFinishTime: number | null = null;
  private finishedCount = 0;
  private standings: Standing[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly geometry: TrackGeometry,
    private readonly zones: ForceZone[],
    players: Player[],
    private readonly events: RaceEvents = {},
    /** Overridable so the tuning harness can isolate speed-related failures. */
    private readonly maxSpeed: number = DEFAULT_MAX_SPEED,
  ) {
    this.spawnMarbles(players);
  }

  /** Lines the marbles up across the start shelf, in rows. */
  private spawnMarbles(players: Player[]): void {
    const perRow = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(players.length))));
    const startFrame = this.geometry.frameAt(this.geometry.plan.startIndex);
    const spacing = TRACK_CONSTANTS.marbleRadius * 2.5;

    players.forEach((player, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const rowCount = Math.min(perRow, players.length - row * perRow);
      const lateral = (col - (rowCount - 1) / 2) * spacing;

      const frame = this.geometry.frameAt(this.geometry.plan.startIndex - row * 1.3);
      const position = frame.position
        .add(frame.right.scale(lateral))
        .add(frame.up.scale(TRACK_CONSTANTS.marbleRadius * 1.4));

      const marble = new Marble(this.scene, player, position);
      marble.freeze();
      marble.progressIndex = this.geometry.plan.startIndex;
      marble.distance = this.geometry.distanceAtIndex(marble.progressIndex);
      marble.bestDistance = marble.distance;
      marble.progressWatermark = marble.distance;
      this.marbles.push(marble);
    });

    void startFrame;
  }

  beginCountdown(seconds = 3): void {
    this.state = "countdown";
    this.countdownRemaining = seconds;
    this.lastCountdownAnnounced = seconds + 1;
    this.simTime = -seconds;
  }

  /** Skips straight to the flag — used by the "skip to result" button. */
  isRunning(): boolean {
    return this.state === "countdown" || this.state === "racing";
  }

  /**
   * Advances the simulation by one fixed step. Called from the scene's
   * before-physics hook so it stays locked to the physics rate.
   */
  step(): void {
    if (this.state === "ready" || this.state === "finished") return;

    this.simTime += FIXED_STEP;

    if (this.state === "countdown") {
      this.countdownRemaining -= FIXED_STEP;
      const whole = Math.ceil(this.countdownRemaining);
      if (whole < this.lastCountdownAnnounced) {
        this.lastCountdownAnnounced = whole;
        this.events.onCountdownTick?.(Math.max(0, whole));
      }
      if (this.countdownRemaining <= 0) {
        this.state = "racing";
        this.simTime = 0;
        for (const marble of this.marbles) marble.release();
        this.events.onStart?.();
      }
      return;
    }

    for (const marble of this.marbles) {
      if (marble.finished) continue;
      this.applyZones(marble);
      this.applyResistance(marble);
    }
  }

  /** Called after the physics step, once transforms have been synced back. */
  postStep(): void {
    if (this.state !== "racing") {
      for (const marble of this.marbles) marble.settleTeleport();
      return;
    }

    for (const marble of this.marbles) {
      marble.settleTeleport();
      if (marble.finished) {
        if (marble.retireAt !== null && this.simTime >= marble.retireAt) marble.retire();
        continue;
      }
      this.updateProgress(marble);
      if (this.probeMode) continue;
      this.checkRecovery(marble);
      this.checkFinish(marble);
    }

    this.recomputeStandings();

    if (this.probeMode) return;

    // Wrap the race up when everyone is home, when the stragglers run out of
    // time, or when the race has simply gone on too long to be a race.
    if (this.finishedCount === this.marbles.length) {
      this.complete();
    } else if (
      this.firstFinishTime !== null &&
      this.simTime - this.firstFinishTime > STRAGGLER_GRACE
    ) {
      this.complete();
    } else if (this.simTime > MAX_RACE_SECONDS) {
      this.complete();
    }
  }

  private applyZones(marble: Marble): void {
    if (this.zones.length === 0) return;
    const index = marble.progressIndex;
    for (const zone of this.zones) {
      if (index < zone.from || index > zone.to) continue;
      const frame = this.geometry.frameAt(index);
      // Only affect marbles actually in the channel, not ones flying past.
      const offset = marble.position.subtract(frame.position);
      if (offset.length() > frame.width * 2.2) continue;
      // Zones return an acceleration; marble mass is 1, so it is also a force.
      const force = zone.force(frame, marble.velocity);
      marble.aggregate.body.applyForce(force, marble.position);
    }
  }

  /**
   * Rolling resistance, plus a drag term that becomes significant near the
   * speed ceiling.
   *
   * Havok has no rolling friction of its own, so without this a marble on any
   * slope accelerates indefinitely — which is precisely what a real marble
   * does not do. Rolling resistance is a constant deceleration opposing
   * motion, exactly as the textbook model has it, so the run settles into the
   * gentle, steady flow a wooden marble run actually has.
   */
  private applyResistance(marble: Marble): void {
    const v = marble.velocity;
    const speed = v.length();
    marble.speed = speed;
    if (speed > marble.peakSpeed) marble.peakSpeed = speed;
    marble.speedSum += speed;
    marble.speedSamples += 1;

    if (speed < 1e-3) return;

    // Constant retarding acceleration from rolling and wall-rub losses.
    const rolling = PHYSICS.rollingResistance * GRAVITY;
    let deceleration = rolling;

    // Drag. A low exponent on purpose: it starts to bite well before the
    // ceiling, so a marble eases up to its top speed over a couple of metres
    // instead of leaping to it the moment the track tips downhill. A steeper
    // curve holds the same ceiling but makes everything below it feel abrupt.
    const ratio = speed / this.maxSpeed;
    deceleration += rolling * 6 * Math.pow(ratio, 3);

    // Never reverse a marble: cap the impulse at what stops it this step.
    const delta = Math.min(deceleration * FIXED_STEP, speed);
    marble.setVelocity(v.scale((speed - delta) / speed));
  }

  private updateProgress(marble: Marble): void {
    const index = this.geometry.nearestIndex(marble.position, marble.progressIndex);
    marble.progressIndex = index;
    marble.distance = this.geometry.distanceAtIndex(index);
    if (marble.distance > marble.bestDistance) marble.bestDistance = marble.distance;

    if (marble.bestDistance > marble.progressWatermark + PROGRESS_EPSILON) {
      marble.progressWatermark = marble.bestDistance;
      marble.noProgressFor = 0;
    } else {
      marble.noProgressFor += FIXED_STEP;
    }
  }

  /** Rescues marbles that have fallen off the track or wedged themselves. */
  private checkRecovery(marble: Marble): void {
    const frame = this.geometry.frameAt(marble.progressIndex);
    const offset = marble.position.subtract(frame.position);
    const sideways = Math.abs(Vector3.Dot(offset, frame.right));
    const vertical = Vector3.Dot(offset, frame.up);
    const inGap = this.geometry.isInGap(marble.progressIndex);

    marble.lastLateral = sideways;
    marble.lastVertical = vertical;
    marble.lastInGap = inGap;

    // Airborne over a jump is expected, so gaps get a much wider tolerance.
    const margin = TRACK_CONSTANTS.marbleRadius * OFF_TRACK_MARGIN * (inGap ? 4 : 1);
    const outsideWalls = sideways > frame.width + margin;
    const overTheTop = vertical > frame.wallHeight + margin;
    const belowTheFloor = vertical < -margin;

    if (outsideWalls || overTheTop || belowTheFloor) {
      // Snapshot the moment of departure, not the state 1.1s later once it has
      // fallen a long way — the onset is what says how it got out.
      if (marble.offTrackFor === 0) {
        marble.departureSide = Vector3.Dot(offset, frame.right);
        marble.departureUp = Vector3.Dot(offset, frame.up);
        marble.departureSpeed = marble.speed;
        marble.departureWidth = frame.width;
        marble.departureWall = frame.wallHeight;
      }
      marble.offTrackFor += FIXED_STEP;
    } else {
      marble.offTrackFor = 0;
    }

    if (marble.speed < STALL_SPEED) marble.stalledFor += FIXED_STEP;
    else marble.stalledFor = 0;

    if (marble.offTrackFor > OFF_TRACK_GRACE) {
      this.rescue(marble, "off-track");
      return;
    }

    if (marble.noProgressFor > NO_PROGRESS_RESCUE_AFTER) {
      this.rescue(marble, "no-progress");
      return;
    }

    if (marble.stalledFor > STALL_RESCUE_AFTER) {
      this.rescue(marble, "stalled");
    } else if (marble.stalledFor > STALL_NUDGE_AFTER) {
      // A shove down the track first — less disruptive than a full rescue.
      // A shove worth about 15 cm/s, enough to unstick without teleporting.
      const push = frame.tangent.scale(15 * (marble.aggregate.body.getMassProperties().mass ?? 1));
      marble.aggregate.body.applyImpulse(push, marble.position);
      marble.stalledFor = STALL_NUDGE_AFTER * 0.5;
    }
  }

  private rescue(marble: Marble, reason: RescueReason): void {
    // Normally a marble goes back a little way and re-runs the bit that caught
    // it out. But if it keeps failing at the same place, going back just feeds
    // the loop — so each repeat at the same spot drops it further forward
    // instead, until it is past the problem entirely.
    const repeated =
      Math.abs(marble.progressIndex - marble.lastRescueIndex) < REPEAT_RESCUE_WINDOW;
    marble.repeatRescues = repeated ? marble.repeatRescues + 1 : 0;

    const offset =
      marble.repeatRescues === 0 ? -6 : Math.min(60, marble.repeatRescues * 14);
    const target = Math.max(
      this.geometry.plan.startIndex,
      Math.min(this.geometry.plan.finishIndex, marble.progressIndex + offset),
    );
    const safeIndex = this.findSafeIndex(target);
    const frame = this.geometry.frameAt(safeIndex);

    marble.teleport(frame.position.add(frame.up.scale(TRACK_CONSTANTS.marbleRadius * 1.8)));
    // Set it rolling rather than dropping it in at a standstill, or a flat
    // stretch will simply stall it again on the next step.
    marble.setVelocity(frame.tangent.scale(0.3 * UNITS_PER_METRE));

    marble.progressIndex = safeIndex;
    marble.lastRescueIndex = safeIndex;
    marble.offTrackFor = 0;
    marble.stalledFor = 0;
    marble.noProgressFor = 0;
    marble.progressWatermark = marble.bestDistance;
    marble.rescues += 1;
    this.events.onRescue?.(marble, reason);
  }

  /** Walks backwards out of a jump gap so a rescue never drops into thin air. */
  private findSafeIndex(index: number): number {
    let i = index;
    let guard = 0;
    while (this.geometry.isInGap(i) && i > this.geometry.plan.startIndex && guard++ < 200) {
      i -= 1;
    }
    return i;
  }

  private checkFinish(marble: Marble): void {
    if (marble.progressIndex < this.geometry.plan.finishIndex) return;
    marble.finished = true;
    marble.finishTime = this.simTime;
    marble.retireAt = this.simTime + RETIRE_DELAY;
    marble.place = ++this.finishedCount;
    if (this.firstFinishTime === null) this.firstFinishTime = this.simTime;
    this.events.onFinish?.(marble, marble.place);
  }

  private recomputeStandings(): void {
    const total = this.geometry.plan.distances[this.geometry.plan.finishIndex];
    const sorted = [...this.marbles].sort((a, b) => {
      // Finishers always rank ahead of non-finishers, in finishing order.
      if (a.finished && b.finished) return (a.finishTime ?? 0) - (b.finishTime ?? 0);
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.bestDistance - a.bestDistance;
    });

    const leader = sorted[0];
    this.standings = sorted.map((marble, i) => ({
      marble,
      place: i + 1,
      progress: Math.min(1, marble.bestDistance / total),
      gapToLeader: Math.max(0, leader.bestDistance - marble.bestDistance),
    }));
  }

  getStandings(): Standing[] {
    if (this.standings.length === 0) this.recomputeStandings();
    return this.standings;
  }

  /** The marble the broadcast camera should be watching. */
  getLeader(): Marble | null {
    const running = this.getStandings().filter((s) => !s.marble.finished);
    if (running.length > 0) return running[0].marble;
    return this.marbles[0] ?? null;
  }

  private complete(): void {
    if (this.state === "finished") return;
    this.state = "finished";
    this.recomputeStandings();
    for (const standing of this.standings) {
      standing.marble.place = standing.place;
    }
    this.events.onRaceComplete?.(this.standings);
  }

  /** Ends the race immediately, ranking whoever is still out on track. */
  forceComplete(): void {
    this.complete();
  }

  /** Frame-time visual updates that must not run on the physics clock. */
  updateVisuals(dt: number): void {
    for (const marble of this.marbles) marble.updateVisual(dt);
  }

  dispose(): void {
    for (const marble of this.marbles) marble.dispose();
    this.marbles.length = 0;
  }
}
