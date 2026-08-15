import type { Player } from "../game/marble";

/**
 * Racer roster: colours, defaults, and remembering names between visits.
 */

/**
 * Marble colours, ordered so that any prefix of the list stays easy to tell
 * apart — including for the most common forms of colour blindness, which is
 * why red and green are never adjacent picks.
 */
export const MARBLE_COLORS = [
  "#ff4d6d", // raspberry
  "#4dabff", // azure
  "#ffd23f", // sunflower
  "#2fd18b", // jade
  "#c77dff", // violet
  "#ff8c42", // tangerine
  "#00d5d5", // teal
  "#f5f0e8", // pearl
  "#8b6cff", // indigo
  "#ff6fd8", // orchid
  "#9bd643", // lime
  "#b0782c", // bronze
] as const;

export const MAX_PLAYERS = MARBLE_COLORS.length;
export const MIN_PLAYERS = 2;

const STORAGE_KEY = "marble-run:roster";

export function colorFor(index: number): string {
  return MARBLE_COLORS[index % MARBLE_COLORS.length];
}

export function makePlayers(names: string[]): Player[] {
  return names.map((name, i) => ({
    id: i,
    name: name.trim() || `Racer ${i + 1}`,
    color: colorFor(i),
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
