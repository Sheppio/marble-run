import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TrackPlan } from "./plan";

/**
 * Per-point frames along the centreline: where the track is, which way it
 * points, and which way is "up" for a marble sitting in the channel.
 *
 * Frames are anchored to world up, so the channel can never roll over.
 */
export interface TrackFrame {
  position: Vector3;
  tangent: Vector3;
  right: Vector3;
  up: Vector3;
  /** Banking applied at this point, radians. */
  bank: number;
  width: number;
  /** Wall height here — corners are walled higher than straights. */
  wallHeight: number;
}

export class TrackGeometry {
  readonly frames: TrackFrame[] = [];

  constructor(readonly plan: TrackPlan) {
    const { points, widths, banks, wallHeights } = plan;
    const count = points.length;

    // Tangents from central differences.
    const tangents: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(count - 1, i + 1)];
      const t = next.subtract(prev);
      if (t.lengthSquared() < 1e-8) t.set(0, 0, 1);
      tangents.push(t.normalize());
    }

    const worldUp = new Vector3(0, 1, 0);

    for (let i = 0; i < count; i++) {
      const tangent = tangents[i];

      // Frame taken from world up, the way a road is built, rather than
      // carried along the curve from the previous frame.
      //
      // Propagating a frame (parallel transport) is the right tool for a track
      // that corkscrews or inverts, but it accumulates roll: small errors
      // compound over a thousand points and the channel gradually rotates
      // until it is upside down and tips its marbles out. This run never
      // inverts and never exceeds about 20° of pitch, so anchoring every frame
      // to world up is both correct and impossible to drift.
      //
      // Left-handed basis, to match Babylon: (right, up, tangent).
      const right = Vector3.Cross(worldUp, tangent);
      if (right.lengthSquared() < 1e-8) {
        // Only reachable if the track went vertical, which it cannot.
        right.set(1, 0, 0);
      }
      right.normalize();
      const up = Vector3.Cross(tangent, right).normalize();

      // Bank so the outside of the corner rises. The magnitude comes from the
      // plan, which derived it from cornering force; the sign is resolved here
      // against this frame's own notion of "right".
      const prevT = tangents[Math.max(0, i - 1)];
      const nextT = tangents[Math.min(count - 1, i + 1)];
      const inward = nextT.subtract(prevT);
      inward.y = 0;
      let bank = 0;
      if (inward.lengthSquared() > 1e-8) {
        inward.normalize();
        const side = Vector3.Dot(inward, right);
        bank = -Math.sign(side) * Math.abs(banks[i]);
      }

      const bankedRight = right.scale(Math.cos(bank)).add(up.scale(Math.sin(bank)));
      const bankedUp = right.scale(-Math.sin(bank)).add(up.scale(Math.cos(bank)));

      this.frames.push({
        position: points[i],
        tangent,
        right: bankedRight,
        up: bankedUp,
        bank,
        width: widths[i],
        wallHeight: wallHeights[i],
      });
    }
  }

  get length(): number {
    return this.plan.totalLength;
  }

  /** Frame at a fractional index, linearly blended. */
  frameAt(index: number): TrackFrame {
    const clamped = Math.max(0, Math.min(this.frames.length - 1, index));
    const i = Math.floor(clamped);
    const j = Math.min(this.frames.length - 1, i + 1);
    const t = clamped - i;
    const a = this.frames[i];
    const b = this.frames[j];
    return {
      position: Vector3.Lerp(a.position, b.position, t),
      tangent: Vector3.Lerp(a.tangent, b.tangent, t).normalize(),
      right: Vector3.Lerp(a.right, b.right, t).normalize(),
      up: Vector3.Lerp(a.up, b.up, t).normalize(),
      bank: a.bank + (b.bank - a.bank) * t,
      width: a.width + (b.width - a.width) * t,
      wallHeight: a.wallHeight + (b.wallHeight - a.wallHeight) * t,
    };
  }

  /** Converts an arc-length distance into a fractional centreline index. */
  indexAtDistance(distance: number): number {
    const d = this.plan.distances;
    if (distance <= 0) return 0;
    if (distance >= this.plan.totalLength) return d.length - 1;
    // Binary search — distances are monotonically increasing.
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= distance) lo = mid;
      else hi = mid;
    }
    const span = d[hi] - d[lo];
    return span > 1e-6 ? lo + (distance - d[lo]) / span : lo;
  }

  distanceAtIndex(index: number): number {
    const d = this.plan.distances;
    const clamped = Math.max(0, Math.min(d.length - 1, index));
    const i = Math.floor(clamped);
    const j = Math.min(d.length - 1, i + 1);
    return d[i] + (d[j] - d[i]) * (clamped - i);
  }

  /**
   * Finds the centreline index nearest to a world position, searching outward
   * from a hint. Marbles move a bounded distance per frame, so a local search
   * from their last known index is both fast and robust.
   */
  nearestIndex(position: Vector3, hint: number, window = 40): number {
    const from = Math.max(0, Math.floor(hint) - window);
    const to = Math.min(this.frames.length - 1, Math.ceil(hint) + window);
    let best = from;
    let bestDist = Infinity;
    for (let i = from; i <= to; i++) {
      const d = Vector3.DistanceSquared(this.frames[i].position, position);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    // Refine to a fraction by projecting onto the neighbouring span.
    const frame = this.frames[best];
    const delta = position.subtract(frame.position);
    const along = Vector3.Dot(delta, frame.tangent);
    const spacing = best < this.frames.length - 1 ? Vector3.Distance(frame.position, this.frames[best + 1].position) : 1;
    return best + Math.max(-0.999, Math.min(0.999, along / Math.max(0.001, spacing)));
  }

  isInGap(index: number): boolean {
    for (const gap of this.plan.gaps) {
      if (index >= gap.startIndex - 1 && index <= gap.endIndex + 1) return true;
    }
    return false;
  }
}
