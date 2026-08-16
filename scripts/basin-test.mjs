/**
 * Checks that marbles which cross the line stay on the run instead of rolling
 * off the open end of the catch basin.
 *
 * Usage: node scripts/basin-test.mjs [--seeds 12]
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
const SEEDS = readArg("seeds", 12);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
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
  s.listen(4326, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  if (process.env.NO_END_WALL) await page.addInitScript(() => { window.__noEndWall = true; });
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4326/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.basinTest === "function", { timeout: 30000 });

  console.log(`\n=== catch basin · ${SEEDS} seeds ===\n`);
  console.log("  seed          finishers   fell off   worst drop");
  console.log("  " + "-".repeat(48));

  let totalFell = 0;
  let totalFinishers = 0;
  let worstOverall = 0;

  for (let i = 0; i < SEEDS; i++) {
    const seed = `BASIN-${i}`;
    const r = await page.evaluate((s) => window.basinTest(s, 6), seed);
    totalFell += r.fell;
    totalFinishers += r.finishers;
    worstOverall = Math.max(worstOverall, r.worstDrop);
    const flag = r.fell > 0 ? "  <-- falling off" : "";
    console.log(
      `  ${seed.padEnd(14)}${String(r.finishers).padEnd(12)}${String(r.fell).padEnd(11)}${r.worstDrop.toFixed(1)}cm${flag}`,
    );
  }

  console.log("");
  console.log(`  ${totalFell} of ${totalFinishers} finishers left the track`);
  console.log(`  worst drop below the basin floor: ${worstOverall.toFixed(1)}cm`);
  console.log("");
  process.exitCode = totalFell > 0 ? 1 : 0;
} finally {
  await browser.close();
  server.close();
}
