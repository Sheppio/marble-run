import type { Player } from "../game/marble";

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

/** Saturation and value for the coloured marbles. High: these read at a distance. */
const MARBLE_SATURATION = 0.9;
const MARBLE_VALUE = 1.0;

/** The two neutrals, used once the field is large enough to spare the slots. */
const PEARL = "#f7f7fa";
const OBSIDIAN = "#16161c";

/** Below this many racers, every marble gets a hue — neutrals would dominate. */
const NEUTRALS_FROM = 5;

const STORAGE_KEY = "marble-run:roster";
const THEME_KEY = "marble-run:theme";

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

export const MAX_PLAYERS = 12;
export const MIN_PLAYERS = 2;

function hsvToHex(hue: number, saturation: number, value: number): string {
  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;
  const sector = Math.floor(hue / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector];
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** The colours for a field of `count` marbles, in racing order. */
export function paletteFor(count: number): string[] {
  const size = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, count));
  const withNeutrals = size >= NEUTRALS_FROM;
  const hueCount = withNeutrals ? size - 2 : size;

  const colours: string[] = [];
  for (let i = 0; i < hueCount; i++) {
    // Start a little off red, so the first marble is not the same colour as
    // every warning light the eye is trained to ignore.
    const hue = (25 + (i * 360) / hueCount) % 360;
    colours.push(hsvToHex(hue, MARBLE_SATURATION, MARBLE_VALUE));
  }
  if (withNeutrals) colours.push(PEARL, OBSIDIAN);
  return colours;
}

export function colorFor(index: number, count: number): string {
  const palette = paletteFor(count);
  return palette[index % palette.length];
}

export function makePlayers(names: string[]): Player[] {
  const palette = paletteFor(names.length);
  return names.map((name, i) => ({
    id: i,
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
