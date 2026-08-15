/**
 * Picks rendering quality from what the device tells us about itself.
 *
 * Deliberately conservative: this has to hold 60fps on a mid-range phone, and
 * a race that stutters is worse than one that renders a little softer.
 */

export interface QualitySettings {
  tier: "low" | "medium" | "high";
  /**
   * Babylon's hardware scaling level: the render buffer is the CSS size
   * *divided* by this. So 1 draws at CSS resolution, 0.5 draws at twice it
   * (crisp on a high-density screen), and anything above 1 draws at less than
   * CSS resolution and is upscaled to fit.
   *
   * The sense of this is easy to get backwards, and getting it backwards is
   * expensive: a phone reporting a device pixel ratio of 3 was being given a
   * scaling level of 2.4, which drew the whole scene at about four tenths of
   * CSS resolution and then stretched it over the screen. Every edge in the
   * run was visibly stepped.
   */
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

  // Multisampling is on at every tier. On the tile-based GPUs phones use it is
  // close to free, and the run is nearly all long straight edges — a channel
  // rim, a row of pins — which is exactly what aliasing shows up on worst.
  if (isMobile && (cores <= 4 || memory <= 3)) {
    return {
      tier: "low",
      // CSS resolution: sharp enough to lose the stepping, cheap enough for a
      // weak GPU.
      hardwareScaling: 1,
      shadows: false,
      shadowMapSize: 512,
      antialias: true,
      glow: false,
      scenery: false,
    };
  }

  if (isMobile) {
    return {
      tier: "medium",
      // Half again over CSS resolution. Beyond about this a phone is shading
      // pixels nobody can distinguish, at real cost to the frame budget.
      hardwareScaling: 1 / Math.min(dpr, 1.5),
      shadows: true,
      shadowMapSize: 1024,
      antialias: true,
      glow: false,
      scenery: true,
    };
  }

  return {
    tier: "high",
    hardwareScaling: 1 / Math.min(dpr, 2),
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    glow: true,
    scenery: true,
  };
}
