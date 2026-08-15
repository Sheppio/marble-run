/**
 * Picks rendering quality from what the device tells us about itself.
 *
 * Deliberately conservative: this has to hold 60fps on a mid-range phone, and
 * a race that stutters is worse than one that renders a little softer.
 */

export interface QualitySettings {
  tier: "low" | "medium" | "high";
  /** Babylon hardware scaling; >1 renders below native resolution. */
  hardwareScaling: number;
  shadows: boolean;
  shadowMapSize: number;
  antialias: boolean;
  glow: boolean;
  /** Draw support pillars and other non-essential scenery. */
  scenery: boolean;
}

export function detectQuality(): QualitySettings {
  const dpr = window.devicePixelRatio || 1;
  const cores = navigator.hardwareConcurrency || 4;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? (isMobile ? 4 : 8);

  if (isMobile && (cores <= 4 || memory <= 3)) {
    return {
      tier: "low",
      hardwareScaling: Math.max(1, Math.min(dpr, 1.5)),
      shadows: false,
      shadowMapSize: 512,
      antialias: false,
      glow: false,
      scenery: false,
    };
  }

  if (isMobile) {
    return {
      tier: "medium",
      // Cap at 1.25× device pixels — beyond that a phone is shading pixels
      // nobody can see, at real cost to the frame budget.
      hardwareScaling: Math.max(1, dpr / 1.25),
      shadows: true,
      shadowMapSize: 1024,
      antialias: false,
      glow: false,
      scenery: true,
    };
  }

  return {
    tier: "high",
    hardwareScaling: Math.max(1, dpr / 2),
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    glow: true,
    scenery: true,
  };
}
