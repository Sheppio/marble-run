import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";

/**
 * Materials for the run.
 *
 * Everything is physically-based and lit by the procedural sky, so surfaces
 * only need to say what they are made of — a metal pin, a lacquered marble,
 * varnished timber — and the environment does the rest. There are no texture
 * maps anywhere: the whole app stays code-only, which keeps it a fast download
 * on a phone, so materials have to carry the look through roughness, metalness
 * and the clear coat alone.
 */

export interface SurfaceOptions {
  metallic: number;
  roughness: number;
  /** Emissive contribution, as a fraction of the base colour. */
  glow?: number;
  /** A lacquered top layer — the difference between plastic and glass. */
  clearCoat?: number;
  environmentIntensity?: number;
}

/** A general opaque surface. */
export function createSurface(
  scene: Scene,
  name: string,
  color: Color3,
  options: SurfaceOptions,
): PBRMaterial {
  const material = new PBRMaterial(name, scene);
  material.albedoColor = color;
  material.metallic = options.metallic;
  material.roughness = options.roughness;
  material.environmentIntensity = options.environmentIntensity ?? 0.7;
  if (options.glow) material.emissiveColor = color.scale(options.glow);
  if (options.clearCoat) {
    material.clearCoat.isEnabled = true;
    material.clearCoat.intensity = options.clearCoat;
    material.clearCoat.roughness = 0.06;
  }
  return material;
}

/**
 * A racing marble.
 *
 * Glass, so: barely rough, a strong clear coat for the wet highlight, and a
 * full share of the environment for the reflection that sells it as a sphere
 * rather than a flat disc. A little emissive keeps a marble's colour readable
 * when it is in shadow, which matters because the colour is how a player finds
 * themselves in the pack.
 */
export function createMarbleMaterial(scene: Scene, name: string, color: Color3): PBRMaterial {
  const material = createSurface(scene, name, color, {
    metallic: 0.0,
    roughness: 0.04,
    clearCoat: 1.0,
    environmentIntensity: 1.15,
  });
  material.emissiveColor = color.scale(0.12);
  // A touch of sheen at grazing angles, which is what reads as "glass".
  material.sheen.isEnabled = true;
  material.sheen.intensity = 0.35;
  material.sheen.color = Color3.White();
  return material;
}

/** Varnished timber, for the track itself. */
export function createTimberMaterial(scene: Scene, name: string): PBRMaterial {
  const material = createSurface(scene, name, Color3.White(), {
    metallic: 0.0,
    roughness: 0.58,
    // Light varnish only. A strong clear coat washes the grain colour out
    // into a flat cream, which is what an earlier pass looked like.
    clearCoat: 0.18,
    environmentIntensity: 0.4,
  });
  return material;
}

/**
 * The colour scheme of a track, derived from its seed.
 *
 * Kept within a band of warm timbers rather than the full colour wheel: every
 * track should look like the same workshop made it, and a lilac or mint green
 * marble run looks like a bug rather than a choice.
 */
export interface TimberPalette {
  floor: Color3;
  wall: Color3;
  underside: Color3;
  stripe: Color3;
}

export function deriveTimberPalette(seedValue: number): TimberPalette {
  // Hue restricted to the range from walnut through oak to beech.
  const hue = 20 + (seedValue % 26);
  const saturation = 0.42 + ((seedValue >> 8) % 14) / 100;

  return {
    floor: Color3.FromHSV(hue, saturation, 0.34),
    // Walls catch the light, so they read a shade lighter than the floor.
    wall: Color3.FromHSV(hue, saturation * 0.9, 0.46),
    // The underside is in permanent shadow; keeping it dark gives the run
    // a sense of thickness from below.
    underside: Color3.FromHSV(hue, saturation * 1.15, 0.15),
    // Cross-grain banding, a shade paler, to give a sense of travel.
    stripe: Color3.FromHSV(hue + 6, saturation * 0.7, 0.45),
  };
}
