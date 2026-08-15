/** Small helpers so screen code reads as structure rather than boilerplate. */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Formats seconds as m:ss.hh, or "—" for a marble that never finished. */
export function formatTime(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = Math.floor(rest);
  const hundredths = Math.floor((rest - whole) * 100);
  const secs = `${String(whole).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
  return minutes > 0 ? `${minutes}:${secs}` : secs;
}

/** Formats a world-unit distance for the HUD: centimetres, or metres if far. */
export function formatDistance(units: number): string {
  const metres = units / 100;
  return metres >= 1 ? `${metres.toFixed(1)}m` : `${Math.round(units)}cm`;
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}
