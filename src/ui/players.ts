import type { Player } from "../game/marble";
import { MARBLE_PATTERNS } from "../render/textures";

/**
 * Racer roster: colours, defaults, and remembering names between visits.
 */

/**
 * Marble colours.
 *
 * Built from the colour wheel divided by the size of the field, so however
 * many are racing, the hues are as far apart as they can be. Once there are
 * enough racers to spare them, a white and a black marble join the set: they
 * are instantly recognisable, and no hue can be confused with them.
 *
 * The consequence — which is deliberate but worth knowing — is that adding or
 * removing a racer re-colours the whole field. Fixing each player to a colour
 * for life would mean a fixed list, and a fixed list either wastes the wheel
 * on small fields or crowds it on large ones.
 */


/** The two neutrals, used once the field is large enough to spare the slots. */
const PEARL = "#f7f7fa";
const OBSIDIAN = "#16161c";

/** Below this many racers, every marble gets a hue — neutrals would dominate. */

const STORAGE_KEY = "marble-run:roster";
const THEME_KEY = "marble-run:theme";
const BOARD_KEY = "marble-run:board";

/** Where the scoreboard sits: along the bottom, or down the left. */
export type BoardLayout = "bottom" | "side";

export function loadBoardLayout(): BoardLayout {
  try {
    return localStorage.getItem(BOARD_KEY) === "side" ? "side" : "bottom";
  } catch {
    return "bottom";
  }
}

export function saveBoardLayout(layout: BoardLayout): void {
  try {
    localStorage.setItem(BOARD_KEY, layout);
  } catch {
    // Private browsing; the board just reverts to the default next time.
  }
}

/** The visual theme chosen last time, if any. */
export function loadThemeId(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function saveThemeId(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    // Private browsing; the theme just reverts to the default next time.
  }
}

/**
 * Nine solid colours, then those same nine again wearing one of the two
 * patterned finishes — so eighteen is exactly what the palette can carry with
 * every marble a distinct colour-and-finish pair. Past that the pairs would
 * start repeating.
 */
export const MAX_PLAYERS = 18;
export const MIN_PLAYERS = 2;


/**
 * The solid colours, in the order they are handed out.
 *
 * Hand-picked and then measured, rather than stepped evenly round the hue
 * wheel. Even hue steps are the obvious approach and a bad one: HSV hue is not
 * perceptually uniform, so a step that is an obvious jump across the oranges is
 * nearly nothing across the greens. The old palette divided 360° by the field
 * size, and at twelve racers its closest pair came out at ΔE 5.7 under
 * CIEDE2000 — two hues 36° apart that the eye reads as the same green.
 *
 * Every pair in this set is at least ΔE 25 apart, which is comfortable for
 * small moving objects on a phone. Check it with `npm run palette`.
 *
 * Purple is deliberately absent. It sits between blue and magenta and cannot be
 * separated from both: including it dragged the worst pair down to ΔE 16
 * however its lightness was adjusted.
 */
const BASE_COLOURS = [
  "#ff2020", // red
  "#ff8c00", // orange
  "#ffe000", // yellow
  "#1f9e28", // green
  "#28e0d8", // cyan
  "#1832d8", // blue
  "#ff3090", // magenta
  PEARL,
  OBSIDIAN,
];

/**
 * Colour for the marble at `index`.
 *
 * Fixed rather than derived from the field size, so a player keeps their colour
 * when somebody else joins or leaves. The old scheme re-divided the wheel every
 * time the roster changed, which quietly recoloured everyone.
 */
export function colorFor(index: number): string {
  return BASE_COLOURS[index % BASE_COLOURS.length];
}

/**
 * Which marking the marble at `index` wears: 0 solid, then the texture
 * variants once the solid colours run out.
 *
 * Colour is one axis and it is exhausted at nine. Past that the same colours
 * come round again wearing a pattern, which is a second axis and a far cheaper
 * one than trying to squeeze a tenth distinguishable hue out of the wheel. In
 * practice most fields are under nine and every marble is plain glass.
 */
export function patternFor(index: number): number {
  const base = BASE_COLOURS.length;
  if (index < base) return 0;
  // Alternate the two patterned finishes rather than exhausting one before
  // starting the next, or with nine solid colours and a cap of twelve racers
  // the spotted variant would never appear at all.
  //
  // Colour and finish together stay unique because the number of base colours
  // is odd: a marble nine places later lands on the same colour but the
  // opposite pattern. That holds to 27 racers, well past the cap.
  return 1 + ((index - base) % (MARBLE_PATTERNS - 1));
}

/**
 * The contrasting tone a marble's markings are drawn in: white on anything
 * dark, near-black on the pale ones.
 *
 * Mirrors the rule in `marbleTexture`, so a swatch on the scoreboard wears the
 * same markings in the same colours as the marble it stands for.
 */
export function accentFor(hex: string): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return luminance > 0.55 ? "#17171f" : "#f7f7fc";
}

/** The colours for a field of `count` marbles, in racing order. */
export function paletteFor(count: number): string[] {
  const size = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, count));
  return Array.from({ length: size }, (_, i) => colorFor(i));
}

export function makePlayers(names: string[]): Player[] {
  const palette = paletteFor(names.length);
  return names.map((name, i) => ({
    id: i,
    pattern: patternFor(i),
    name: name.trim() || `Racer ${i + 1}`,
    color: palette[i % palette.length],
  }));
}

export function loadRoster(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ["", ""];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ["", ""];
    const names = parsed.filter((n): n is string => typeof n === "string").slice(0, MAX_PLAYERS);
    // Pad rather than discard: a saved roster of one name is still worth
    // keeping, it just needs a second empty row alongside it.
    while (names.length < MIN_PLAYERS) names.push("");
    return names;
  } catch {
    return ["", ""];
  }
}

export function saveRoster(names: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
  } catch {
    // Private browsing or a full quota — not worth interrupting the race over.
  }
}

/** Reads racer names and seed out of the URL, for shared links. */
export function readShareLink(): { names?: string[]; seed?: string } {
  const params = new URLSearchParams(window.location.search);
  const result: { names?: string[]; seed?: string } = {};

  const seed = params.get("seed");
  if (seed) result.seed = seed;

  const players = params.get("players");
  if (players) {
    const names = players
      .split(",")
      .map((n) => n.trim().slice(0, 16))
      .filter((n) => n.length > 0)
      .slice(0, MAX_PLAYERS);
    if (names.length >= MIN_PLAYERS) result.names = names;
  }

  return result;
}

export function buildShareLink(seed: string, names: string[]): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("seed", seed);
  url.searchParams.set("players", names.join(","));
  return url.toString();
}
