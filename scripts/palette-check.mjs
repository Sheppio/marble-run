/**
 * Measures how far apart the marble colours actually are.
 *
 * Hue degrees are the obvious unit and the wrong one: HSV hue is not
 * perceptually uniform, so 30° across the oranges is an obvious jump while 30°
 * across the greens is nearly nothing. This converts the palette to CIELAB and
 * reports the closest pair under CIEDE2000, which is a model of what the eye
 * actually resolves.
 *
 * Rough reading of ΔE for this job — small, moving, self-coloured objects seen
 * on a phone, not large flat patches side by side:
 *
 *   under 10   the same colour to a viewer, whatever the hue angle says
 *   10 to 20   tellable apart side by side, not at a glance mid-race
 *   20 to 30   comfortable
 *   over 30    unmistakable
 *
 * Usage: node scripts/palette-check.mjs [--max 12]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const MAX = readArg("max", 12);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

// --- Colour maths ----------------------------------------------------------

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

/** sRGB -> CIELAB, D65. */
function rgbToLab(hex) {
  const linear = hexToRgb(hex).map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  );
  const [r, g, b] = linear;
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000. The standard formulation; see Sharma, Wu & Dalal (2005). */
function deltaE(labA, labB) {
  const [L1, a1, b1] = labA;
  const [L2, a2, b2] = labB;
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const hp = (ap, bp) => {
    if (ap === 0 && bp === 0) return 0;
    const h = Math.atan2(bp, ap) * deg;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(a1p, b1);
  const h2p = hp(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbarp += h1p + h2p < 360 ? 360 : -360;
    hbarp /= 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;

  return Math.sqrt(
    Math.pow(dLp / Sl, 2) +
      Math.pow(dCp / Sc, 2) +
      Math.pow(dHp / Sh, 2) +
      Rt * (dCp / Sc) * (dHp / Sh),
  );
}

// --- Search ----------------------------------------------------------------

function hsvToHex(h, sv, v) {
  const c = v * sv;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h / 60) % 6];
  const ch = (t) => Math.round((t + m) * 255).toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function minSeparation(hexes) {
  const labs = hexes.map(rgbToLab);
  let worst = Infinity;
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) worst = Math.min(worst, deltaE(labs[i], labs[j]));
  }
  return worst;
}

/**
 * Finds a set of `count` colours whose closest pair is as far apart as
 * possible, by coordinate ascent: repeatedly move one colour to its best
 * position with the others held fixed, until nothing improves.
 *
 * Lightness and saturation are searched as well as hue, which matters most in
 * the greens — the band where equal hue steps collapse perceptually. Two greens
 * at different lightnesses separate cleanly where two at the same lightness
 * never will, however far apart their hue angles are.
 */
function searchPalette(count, fixed = []) {
  const SATS = [0.6, 0.75, 0.9, 1.0];
  const VALS = [0.5, 0.68, 0.85, 1.0];
  let best = Array.from({ length: count }, (_, i) => hsvToHex((i * 360) / count, 0.9, 1.0));

  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let i = 0; i < count; i++) {
      let bestHex = best[i];
      let bestScore = minSeparation([...best, ...fixed]);
      for (let h = 0; h < 360; h += 3) {
        for (const sv of SATS) {
          for (const v of VALS) {
            const candidate = [...best];
            candidate[i] = hsvToHex(h, sv, v);
            const score = minSeparation([...candidate, ...fixed]);
            if (score > bestScore + 1e-9) {
              bestScore = score;
              bestHex = candidate[i];
            }
          }
        }
      }
      if (bestHex !== best[i]) {
        best[i] = bestHex;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return best;
}

// --- Report ----------------------------------------------------------------

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  s.listen(4334, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4334/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.__palette === "function", { timeout: 30000 });

  const setArg = args.indexOf("--set");
  if (setArg >= 0) {
    const hexes = args[setArg + 1].split(",").map((h) => h.trim());
    const labs = hexes.map(rgbToLab);
    const pairs = [];
    for (let i = 0; i < labs.length; i++) {
      for (let j = i + 1; j < labs.length; j++) {
        pairs.push({ a: hexes[i], b: hexes[j], d: deltaE(labs[i], labs[j]) });
      }
    }
    pairs.sort((x, y) => x.d - y.d);
    console.log(`\n=== ${hexes.length} colours · closest pairs ===\n`);
    for (const p of pairs.slice(0, 6)) {
      console.log(`  ${p.a} / ${p.b}   ΔE ${p.d.toFixed(1)}`);
    }
    console.log(`\n  worst separation: ΔE ${pairs[0].d.toFixed(1)}\n`);
    process.exit(0);
  }

  if (args.includes("--search")) {
    const withNeutrals = ["#f7f7fa", "#16161c"];
    console.log("\n=== best available palettes (CIEDE2000) ===\n");
    for (const k of [4, 5, 6, 7, 8]) {
      const hues = searchPalette(k, withNeutrals);
      const all = [...hues, ...withNeutrals];
      console.log(`  ${k} hues + white + black  ->  min ΔE ${minSeparation(all).toFixed(1)}`);
      console.log(`    ${hues.join(" ")}`);
    }
    console.log("");
    process.exit(0);
  }

  console.log("\n=== marble palette separation (CIEDE2000) ===\n");
  console.log("  Pairs are compared within a finish; across finishes the");
  console.log("  pattern does the separating.\n");
  console.log("  field   closest same-finish pair   ΔE     verdict");
  console.log("  " + "-".repeat(58));

  for (let n = 2; n <= MAX; n++) {
    const palette = await page.evaluate((count) => window.__palette(count), n);
    const patterns = await page.evaluate(
      (count) => Array.from({ length: count }, (_, i) => window.__pattern(i)),
      n,
    );
    const labs = palette.map(rgbToLab);

    // Only compare marbles wearing the same finish. Two that share a colour
    // but differ in pattern are told apart by the pattern, so scoring them on
    // colour alone would report a failure that is not one.
    let worst = Infinity;
    let pair = [0, 1];
    for (let i = 0; i < labs.length; i++) {
      for (let j = i + 1; j < labs.length; j++) {
        if (patterns[i] !== patterns[j]) continue;
        const d = deltaE(labs[i], labs[j]);
        if (d < worst) {
          worst = d;
          pair = [i, j];
        }
      }
    }
    if (!Number.isFinite(worst)) continue;

    const verdict =
      worst < 10 ? "same colour" : worst < 20 ? "only side by side" : worst < 30 ? "comfortable" : "unmistakable";
    console.log(
      `  ${String(n).padStart(2)}      ${palette[pair[0]]} / ${palette[pair[1]]}      ${worst.toFixed(1).padStart(5)}   ${verdict}`,
    );
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
