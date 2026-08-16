import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Critically damped spring smoothing.
 *
 * The camera used plain exponential smoothing — `lerp(current, desired, 1 -
 * exp(-k·dt))` — which looks fine while the thing being followed moves
 * steadily and badly the moment it does not. Exponential smoothing is at its
 * fastest the instant the gap opens, so any jump in the desired value produces
 * a hard shove followed by a long crawl: it has no easing in at all, only out.
 * Two places made that obvious — the hand-off when the leader finishes and the
 * shot cuts to whoever is next, and the yaw through a tight corner.
 *
 * A critically damped spring carries velocity between frames, so it accelerates
 * from rest, reaches the target and settles without overshoot. `smoothTime` is
 * roughly how long the move takes, which is a far easier thing to reason about
 * than a rate constant.
 *
 * This is the standard formulation (Game Programming Gems 4, 1.10), with the
 * exponential approximated by a rational polynomial so it stays cheap enough to
 * run per axis per frame.
 */
export class SpringVector {
  readonly value = new Vector3();
  private readonly velocity = new Vector3();

  constructor(initial?: Vector3) {
    if (initial) this.value.copyFrom(initial);
  }

  /** Jumps straight to `target`, clearing any momentum. */
  reset(target: Vector3): void {
    this.value.copyFrom(target);
    this.velocity.setAll(0);
  }

  /**
   * Advances one step towards `target`.
   *
   * `smoothTime` is the approximate time to converge, in seconds; larger is
   * lazier. `maxSpeed` caps how fast the value may travel, which is what stops
   * a very distant target — a subject on the far side of the run — turning
   * into a whip pan.
   */
  step(target: Vector3, dt: number, smoothTime: number, maxSpeed = Infinity): void {
    if (dt <= 0) return;
    const omega = 2 / Math.max(0.0001, smoothTime);
    const x = omega * dt;
    // Rational approximation of exp(-x), accurate over the range dt/smoothTime
    // takes in practice and much cheaper than the real thing.
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    let dx = this.value.x - target.x;
    let dy = this.value.y - target.y;
    let dz = this.value.z - target.z;

    const maxChange = maxSpeed * smoothTime;
    if (Number.isFinite(maxChange)) {
      const distance = Math.hypot(dx, dy, dz);
      if (distance > maxChange && distance > 0) {
        const scale = maxChange / distance;
        dx *= scale;
        dy *= scale;
        dz *= scale;
      }
    }

    // The point the spring is actually pulling towards, after clamping.
    const restX = this.value.x - dx;
    const restY = this.value.y - dy;
    const restZ = this.value.z - dz;

    const tempX = (this.velocity.x + omega * dx) * dt;
    const tempY = (this.velocity.y + omega * dy) * dt;
    const tempZ = (this.velocity.z + omega * dz) * dt;

    this.velocity.x = (this.velocity.x - omega * tempX) * decay;
    this.velocity.y = (this.velocity.y - omega * tempY) * decay;
    this.velocity.z = (this.velocity.z - omega * tempZ) * decay;

    this.value.x = restX + (dx + tempX) * decay;
    this.value.y = restY + (dy + tempY) * decay;
    this.value.z = restZ + (dz + tempZ) * decay;
  }
}

/** Smoothstep: zero slope at both ends, so it eases in and out. */
export function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
