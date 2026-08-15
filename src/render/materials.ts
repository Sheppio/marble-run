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
export function createMarbleMaterial(
  scene: Scene,
  name: string,
  color: Color3,
  finish: SurfaceOptions & { emissive: number; sheen: number },
): PBRMaterial {
  const material = createSurface(scene, name, color, finish);
  material.emissiveColor = color.scale(finish.emissive);
  if (finish.sheen > 0) {
    // A touch of sheen at grazing angles is what reads as "glass". Kept
    // subtle: turned up, every marble picks up a hard white rim and starts to
    // look like a sticker rather than a sphere.
    material.sheen.isEnabled = true;
    material.sheen.intensity = finish.sheen;
    material.sheen.color = Color3.White();
  }
  return material;
}

/**
 * The track surface. Vertex colours carry the palette, so the material only
 * decides how the surface behaves in light.
 */
export function createTrackMaterial(
  scene: Scene,
  name: string,
  options: SurfaceOptions,
): PBRMaterial {
  // Emission is dropped here even when a theme asks for it. The whole run is
  // one mesh with one material and its palette lives in vertex colours, but
  // emissive is a material-wide constant — so any glow value lights the deck
  // exactly as brightly as the walls and renders the entire track as a single
  // white slab. (It does: that is what setting it looked like.) Self-lit themes
  // get their glow from threshold bloom, which works off rendered brightness
  // and picks out the lit wall vertices on its own.
  const { glow: _ignored, ...rest } = options;
  return createSurface(scene, name, Color3.White(), rest);
}

/** The colour scheme of a track. Each theme supplies its own. */
export interface TimberPalette {
  floor: Color3;
  wall: Color3;
  underside: Color3;
  stripe: Color3;
}
