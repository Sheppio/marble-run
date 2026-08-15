/**
 * Seed handling: daily seeds, random seeds, and normalisation.
 *
 * Seeds are short human-typeable strings. They are what makes a race
 * repeatable and shareable, so the rules for turning text into a seed have to
 * be stable forever: trim, uppercase, collapse inner whitespace. Nothing else.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — too easy to misread

/** Canonical form of a user-typed seed. Two seeds are the same race iff these match. */
export function normaliseSeed(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ").slice(0, 32);
}

/** The seed everybody in the world gets today, e.g. "DAILY-2026-08-15". */
export function dailySeed(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `DAILY-${y}-${m}-${d}`;
}

export function isDailySeed(seed: string): boolean {
  return normaliseSeed(seed) === dailySeed();
}

/** A fresh six-character seed, e.g. "K7QMZ4". */
export function randomSeed(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Milliseconds until the daily seed rolls over. */
export function msUntilNextDaily(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return next - now.getTime();
}
