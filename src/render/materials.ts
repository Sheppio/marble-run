import { Color3 } from "@babylonjs/core/Maths/math.color";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";
import type { DetailMaps } from "./textures";

/**
 * Materials for the run.
 *
 * Everything is physically-based and lit by the procedural sky, so surfaces
 * only need to say what they are made of — a metal pin, a lacquered marble,
 * varnished timber — and the environment does the rest.
 *
 * The detail and relief maps they use are generated in `textures.ts` rather
 * than downloaded, so the whole app stays code-only and a fast download on a
 * phone. Colour still comes from the material or from vertex colours; the maps
 * only supply the fine variation that stops a surface reading as a flat plane.
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
  swirl: BaseTexture | null,
): PBRMaterial {
  const material = createSurface(scene, name, color, finish);
  material.emissiveColor = color.scale(finish.emissive);
  if (swirl) {
    // Greyscale, multiplying the player's colour: bright texels show the colour
    // of the cane, dark ones read as clear glass. A marble with no swirl is a
    // uniform sphere, and a uniform sphere looks motionless however fast it is
    // actually rolling — the swirl is what makes the roll visible.
    material.albedoTexture = swirl;
  }
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
  detail: DetailMaps | null,
): PBRMaterial {
  // Emission is dropped here even when a theme asks for it. The whole run is
  // one mesh with one material and its palette lives in vertex colours, but
  // emissive is a material-wide constant — so any glow value lights the deck
  // exactly as brightly as the walls and renders the entire track as a single
  // white slab. (It does: that is what setting it looked like.) Self-lit themes
  // get their glow from threshold bloom, which works off rendered brightness
  // and picks out the lit wall vertices on its own.
  const { glow: _ignored, ...rest } = options;
  const material = createSurface(scene, name, Color3.White(), rest);
  applyDetail(material, detail);
  return material;
}

/**
 * Hangs a generated detail map and its relief on a material.
 *
 * The albedo map is greyscale and multiplies whatever colour the surface
 * already has, so one set of maps works for every theme and every palette the
 * seed produces — the wood grain tints itself to the timber it is sitting on.
 */
export function applyDetail(material: PBRMaterial, detail: DetailMaps | null): void {
  if (!detail) return;
  material.albedoTexture = detail.albedo as unknown as BaseTexture;
  material.bumpTexture = detail.normal as unknown as BaseTexture;
  // Babylon reads normal maps in OpenGL convention; these are baked with Y
  // pointing down the texture, which is the opposite.
  material.invertNormalMapY = true;
  material.useParallax = false;
}

/** The colour scheme of a track. Each theme supplies its own. */
export interface TimberPalette {
  floor: Color3;
  wall: Color3;
  underside: Color3;
  stripe: Color3;
}
