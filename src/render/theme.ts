import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { SkyPalette } from "./environment";
import type { SurfaceOptions, TimberPalette } from "./materials";

/**
 * Visual themes.
 *
 * Every theme describes the same run in a different set of materials — the
 * geometry, the physics and the result are untouched. That separation is the
 * whole point: a theme can be as loud as it likes without any risk to the race,
 * and the seed still produces an identical result whichever one is chosen.
 *
 * Each supplies a sky, a lighting rig, a way of colouring the track from the
 * seed, and finishes for the marbles, obstacles and ground.
 */

export interface ThemeLighting {
  sunIntensity: number;
  ambientIntensity: number;
  /** Environment reflections everything picks up from the sky. */
  environmentIntensity: number;
  shadowDarkness: number;
}

export interface Theme {
  id: string;
  label: string;
  /** One-line description, shown on the setup screen. */
  blurb: string;
  sky: SkyPalette;
  lighting: ThemeLighting;
  /** Bloom strength for self-lit surfaces. Omit for themes that do not glow. */
  bloom?: number;
  /** Colours the track from a seed-derived value. */
  track(seedValue: number): TimberPalette;
  /** How the track surface behaves in light. The palette supplies its colour. */
  trackSurface: SurfaceOptions;
  /** Which generated detail map the track and scenery wear. */
  material: "wood" | "plastic" | "panel";
  /** Legs, start gate and finish gantry. */
  decor: { gate: Color3; banner: Color3; support: Color3 };
  /** How a marble's surface behaves; its colour comes from the player. */
  marble: SurfaceOptions & { emissive: number; sheen: number };
  obstacles: {
    pin: { color: Color3; surface: SurfaceOptions };
    post: { color: Color3; surface: SurfaceOptions };
    structure: { color: Color3; surface: SurfaceOptions };
    barrier: { color: Color3; surface: SurfaceOptions };
  };
}

const hsv = (h: number, s: number, v: number) => Color3.FromHSV(h, s, v);

/** Cartoon track hues: teal, sky, violet, slate. See `CARTOON.track`. */
const CARTOON_HUES = [188, 210, 265, 152];

/**
 * Workshop: a varnished wooden run on a lawn, which is the thing this is
 * actually modelling.
 */
const WORKSHOP: Theme = {
  id: "workshop",
  label: "Workshop",
  blurb: "Varnished timber on a summer lawn",
  sky: {
    zenith: Color3.FromHexString("#1b2b5c"),
    horizon: Color3.FromHexString("#79a7d8"),
    ground: Color3.FromHexString("#141a2a"),
    sun: Color3.FromHexString("#fff2d0"),
    clouds: 0.45,
  },
  lighting: {
    sunIntensity: 2.8,
    ambientIntensity: 0.42,
    environmentIntensity: 1.0,
    shadowDarkness: 0.25,
  },
  track(seedValue) {
    // Honey maple, the colour a bowling lane is, with only enough variation
    // between seeds to stop every track looking stamped from one mould.
    //
    // Still darker than it looks it should be. Albedo is not what you see: the
    // surface is lit by a sun at 2.8 and a full share of a bright sky, which
    // lifts it several stops. An earlier pass picked mid-browns here and every
    // track rendered as flat cream.
    const hue = 30 + (seedValue % 14);
    const saturation = 0.52 + ((seedValue >> 8) % 10) / 100;
    return {
      floor: hsv(hue, saturation, 0.34),
      // The walls are the part you read the shape of the run from, so they sit
      // a clear step darker than the lane rather than a subtle one.
      wall: hsv(hue, saturation * 1.1, 0.19),
      underside: hsv(hue, saturation, 0.05),
      // Darker than the lane, not lighter: it reads as a joint across the
      // boards. A pale band over the grain looked like a spill of light.
      stripe: hsv(hue - 4, saturation, 0.1),
    };
  },
  trackSurface: {
    metallic: 0.0,
    // Polished. A lane is under a thick coat of lacquer, and that sheen down
    // the length of it is most of why it reads as a lane rather than as bare
    // board. The clear coat has to stay well under 1 all the same: at full
    // strength it washes the palette out into a flat cream.
    roughness: 0.3,
    clearCoat: 0.5,
    environmentIntensity: 0.5,
  },
  material: "wood",
  decor: {
    gate: Color3.FromHexString("#e8404f"),
    banner: Color3.FromHexString("#f2f4f8"),
    // Warm, not the blue-grey it was: the legs sit against timber and lawn,
    // and a cool grey read as scaffolding poles borrowed from another scene.
    support: Color3.FromHexString("#3a2a1c"),
  },
  marble: {
    metallic: 0.0,
    roughness: 0.04,
    clearCoat: 1.0,
    environmentIntensity: 1.15,
    emissive: 0.1,
    sheen: 0.12,
  },
  obstacles: {
    pin: { color: Color3.FromHexString("#c8d0dd"), surface: { metallic: 0.85, roughness: 0.22 } },
    post: { color: Color3.FromHexString("#e0b14a"), surface: { metallic: 0.6, roughness: 0.3 } },
    structure: { color: Color3.FromHexString("#4e2f16"), surface: { metallic: 0.0, roughness: 0.72 } },
    barrier: { color: Color3.FromHexString("#2c3446"), surface: { metallic: 0.0, roughness: 0.9 } },
  },
};

/**
 * Cartoon: flat, saturated and bright, with the gloss turned off so colours
 * stay exactly the colour they are told to be.
 */
const CARTOON: Theme = {
  id: "cartoon",
  label: "Cartoon",
  blurb: "Flat, bright and bold",
  sky: {
    zenith: Color3.FromHexString("#2f9be8"),
    horizon: Color3.FromHexString("#bfe9ff"),
    ground: Color3.FromHexString("#7ec850"),
    sun: Color3.FromHexString("#ffffff"),
    // Heavier and higher-contrast than Workshop's, to match the poster look.
    clouds: 0.6,
  },
  lighting: {
    sunIntensity: 2.2,
    ambientIntensity: 0.95,
    environmentIntensity: 0.4,
    // Not as pale as it was. A near-invisible shadow left the run looking
    // pasted onto the lawn rather than standing over it, which undoes most of
    // what the shadow pass is for even in a deliberately flat theme.
    shadowDarkness: 0.32,
  },
  track(seedValue) {
    // A curated set rather than the whole wheel. Letting the seed pick any hue
    // sounds fairer but produces tracks the marbles cannot be seen against —
    // the pink one swallowed every warm marble in the field. These four are all
    // cool or neutral, so the warm end of the marble wheel always reads.
    const hue = CARTOON_HUES[seedValue % CARTOON_HUES.length];
    return {
      floor: hsv(hue, 0.62, 0.3),
      // Poster paint: the wall is the same colour turned up, not a different
      // one, so the run reads as a single moulded object.
      wall: hsv(hue, 0.66, 0.62),
      underside: hsv(hue, 0.72, 0.16),
      // Warm against the cool deck. A near-white stripe disappeared into a
      // floor that the sun had already lifted most of the way to white.
      stripe: hsv((hue + 165) % 360, 0.5, 0.7),
    };
  },
  trackSurface: {
    metallic: 0.0,
    // No clear coat at all: the point of this theme is that a colour stays the
    // colour it was given, and a specular layer is exactly what stops that.
    roughness: 0.85,
    environmentIntensity: 0.25,
  },
  material: "plastic",
  decor: {
    gate: Color3.FromHexString("#ff4136"),
    banner: Color3.FromHexString("#ffffff"),
    support: Color3.FromHexString("#8a6a4a"),
  },
  marble: {
    metallic: 0.0,
    roughness: 0.35,
    clearCoat: 0.0,
    environmentIntensity: 0.25,
    // Lifted, because with the gloss gone the colour has to carry the marble.
    emissive: 0.3,
    sheen: 0.0,
  },
  obstacles: {
    pin: { color: Color3.FromHexString("#ffffff"), surface: { metallic: 0.0, roughness: 0.5 } },
    post: { color: Color3.FromHexString("#ff5c3a"), surface: { metallic: 0.0, roughness: 0.5 } },
    structure: { color: Color3.FromHexString("#ffc93c"), surface: { metallic: 0.0, roughness: 0.55 } },
    barrier: { color: Color3.FromHexString("#3c4bd6"), surface: { metallic: 0.0, roughness: 0.55 } },
  },
};

/**
 * Neon: a dark run lit mostly by itself. The track edges and obstacles glow,
 * so the shape of the run is read from its own light rather than the sun's.
 */
const NEON: Theme = {
  id: "neon",
  label: "Neon",
  blurb: "Dark city, glowing edges",
  sky: {
    zenith: Color3.FromHexString("#05030f"),
    horizon: Color3.FromHexString("#2a1050"),
    ground: Color3.FromHexString("#040308"),
    sun: Color3.FromHexString("#ff3fb4"),
  },
  lighting: {
    sunIntensity: 1.1,
    ambientIntensity: 0.28,
    environmentIntensity: 0.8,
    shadowDarkness: 0.1,
  },
  bloom: 0.55,
  track(seedValue) {
    // The deck is near-black and almost neutral, and only the edges take the
    // seed's colour. Tinting the floor with the same hue as the walls is what
    // made an earlier pass a single wash of purple with no shape to it — in a
    // dark scene the contrast between an unlit deck and a lit edge is the only
    // thing drawing the run.
    const hue = seedValue % 360;
    return {
      floor: hsv(hue, 0.18, 0.055),
      wall: hsv(hue, 0.85, 0.62),
      underside: hsv(hue, 0.25, 0.02),
      // The complement, so the distance stripes read as marks on the deck
      // rather than more of the same edge lighting.
      stripe: hsv((hue + 165) % 360, 0.7, 0.5),
    };
  },
  trackSurface: {
    metallic: 0.1,
    // Fairly glossy, so the walls catch the sky's magenta and pick up the
    // brightness that the bloom threshold keys off.
    roughness: 0.3,
    environmentIntensity: 0.35,
  },
  material: "panel",
  decor: {
    gate: Color3.FromHexString("#ff2e88"),
    banner: Color3.FromHexString("#39f0ff"),
    support: Color3.FromHexString("#1a1830"),
  },
  marble: {
    metallic: 0.35,
    roughness: 0.08,
    clearCoat: 0.8,
    environmentIntensity: 0.9,
    // Strongly self-lit: in a dark scene this is what makes the field legible.
    emissive: 0.55,
    sheen: 0.2,
  },
  obstacles: {
    pin: { color: Color3.FromHexString("#39f0ff"), surface: { metallic: 0.3, roughness: 0.15, glow: 0.8 } },
    post: { color: Color3.FromHexString("#ff3fb4"), surface: { metallic: 0.3, roughness: 0.2, glow: 0.8 } },
    structure: { color: Color3.FromHexString("#7a3cff"), surface: { metallic: 0.2, roughness: 0.3, glow: 0.5 } },
    barrier: { color: Color3.FromHexString("#c9ff2e"), surface: { metallic: 0.2, roughness: 0.3, glow: 0.6 } },
  },
};

export const THEMES: Theme[] = [WORKSHOP, CARTOON, NEON];
export const DEFAULT_THEME_ID = WORKSHOP.id;

export function getTheme(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? WORKSHOP;
}
