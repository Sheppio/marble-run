/**
 * Measures how hard the broadcast camera moves.
 *
 * Two complaints this exists to check: the cut when a marble finishes and the
 * shot moves to whoever is next, and the yaw through a tight corner. Both show
 * up as spikes in angular velocity, so the camera's own rotation is sampled
 * every frame and the distribution reported. Peak yaw rate is the number that
 * matters — a high median just means the track turns a lot, but a high peak
 * means at some instant the whole picture whipped round.
 *
 * Usage: node scripts/camera-motion.mjs [--seed X] [--players 8] [--seconds 30]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const SEED = readArg("seed", "MHMSRA");
const PLAYERS = Number(readArg("players", 8));
const SECONDS = Number(readArg("seconds", 30));

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

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
  s.listen(4327, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  const names = Array.from({ length: PLAYERS }, (_, i) => `P${i + 1}`).join(",");
  await page.goto(
    `http://127.0.0.1:4327/?seed=${encodeURIComponent(SEED)}&players=${names}`,
    { waitUntil: "load" },
  );
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  // Let the countdown flythrough finish; it is on a scripted path and is not
  // what either complaint is about.
  await page.waitForTimeout(5000);

  const samples = await page.evaluate((seconds) => {
    return new Promise((resolve) => {
      const rates = [];
      let previous = null;
      let last = performance.now();
      const start = last;

      const tick = () => {
        const now = performance.now();
        const dt = (now - last) / 1000;
        last = now;

        // The camera's forward direction, read off the live world handle.
        const cam = window.__world?.camera?.camera;
        if (cam && dt > 0.0005) {
          const m = cam.getWorldMatrix();
          // Third column of the world matrix is the forward axis.
          const f = { x: m.m[8], y: m.m[9], z: m.m[10] };
          const len = Math.hypot(f.x, f.y, f.z) || 1;
          const dir = { x: f.x / len, y: f.y / len, z: f.z / len };
          if (previous) {
            const dot = Math.max(
              -1,
              Math.min(1, dir.x * previous.x + dir.y * previous.y + dir.z * previous.z),
            );
            const degrees = (Math.acos(dot) * 180) / Math.PI;
            rates.push(degrees / dt);
          }
          previous = dir;
        }

        if (now - start < seconds * 1000) requestAnimationFrame(tick);
        else resolve(rates);
      };
      requestAnimationFrame(tick);
    });
  }, SECONDS);

  if (!samples.length) {
    console.log("\n  no samples captured — the scene handle was not reachable\n");
    process.exitCode = 1;
  } else {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(`\n=== camera motion · seed ${SEED} · ${PLAYERS} marbles ===\n`);
    console.log(`  samples            ${samples.length}`);
    console.log(`  median yaw rate    ${at(0.5).toFixed(1)} deg/s`);
    console.log(`  90th percentile    ${at(0.9).toFixed(1)} deg/s`);
    console.log(`  99th percentile    ${at(0.99).toFixed(1)} deg/s`);
    console.log(`  peak               ${sorted[sorted.length - 1].toFixed(1)} deg/s`);
    console.log("");
  }
} finally {
  await browser.close();
  server.close();
}
