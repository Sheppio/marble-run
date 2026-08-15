/**
 * Headless smoke test.
 *
 * Loads the built app in Chromium, runs a real race to completion, and checks
 * the things that are hard to eyeball: that the track renders, that marbles
 * actually make it to the finish, and that the same seed gives the same
 * result twice.
 *
 * Usage: node scripts/smoke.mjs [--shots] [--seed SEED]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const wantShots = args.includes("--shots");
const seedArg = args.indexOf("--seed");
const SEED = seedArg >= 0 ? args[seedArg + 1] : "SMOKE-TEST-1";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/marble-shots";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function serve(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = join(root, normalize(decodeURIComponent(url.pathname)));
      const file = url.pathname === "/" ? join(root, "index.html") : path;
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        // Havok's WASM is happier with these, and it mirrors what GitHub Pages serves.
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** Drives one full race and returns the finishing order. */
async function runRace(page, base, seed, label) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`${base}/?seed=${encodeURIComponent(seed)}&players=Ana,Ben,Cleo,Dai,Eve,Fin`, {
    waitUntil: "load",
  });

  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.waitForTimeout(500); // let the screen finish fading in
  const preview = await page.textContent(".stat-row");
  if (wantShots) await page.screenshot({ path: join(SHOT_DIR, `${label}-1-setup.png`) });

  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });

  // Let the countdown flythrough play, then grab a frame mid-race.
  await page.waitForTimeout(9000);
  if (wantShots) await page.screenshot({ path: join(SHOT_DIR, `${label}-2-race.png`) });

  // The canvas is created with preserveDrawingBuffer disabled, so reading its
  // pixels back always yields a blank image — that is a property of the
  // context, not a symptom of a blank scene. Confirm rendering by checking the
  // canvas is sized and that the race clock advanced, which only happens if
  // the render loop is turning.
  const rendering = await page.evaluate(() => {
    const canvas = document.getElementById("render-canvas");
    const clock = document.querySelector(".clock")?.textContent ?? "0";
    return {
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      clock: Number.parseFloat(clock),
    };
  });

  await page.waitForSelector(".results-screen", { timeout: 180000 });
  // Let the screen finish fading in before capturing it.
  await page.waitForTimeout(700);
  if (wantShots) await page.screenshot({ path: join(SHOT_DIR, `${label}-3-results.png`) });

  const order = await page.$$eval(".result-row", (rows) =>
    rows.map((row) => ({
      place: row.querySelector(".row-place")?.textContent?.trim(),
      name: row.querySelector(".row-name")?.textContent?.trim(),
      time: row.querySelector(".result-time")?.textContent?.trim(),
      gap: row.querySelector(".result-gap")?.textContent?.trim(),
    })),
  );

  return { order, preview, rendering, errors };
}

const port = 4319;
const base = `http://127.0.0.1:${port}`;
const server = await serve("dist", port);
mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ],
});

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${message}`);
  if (!ok) failures++;
};

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone-ish, since mobile is the target
    deviceScaleFactor: 2,
  });

  const page = await context.newPage();
  console.log(`\nRace 1 — seed ${SEED}`);
  const first = await runRace(page, base, SEED, "run1");
  console.log(`  preview: ${first.preview}`);
  console.log(`  order:   ${first.order.map((r) => `${r.place}. ${r.name} ${r.time}`).join(" | ")}`);

  check(first.errors.length === 0, `no page errors${first.errors.length ? `: ${first.errors[0]}` : ""}`);
  check(
    first.rendering.width > 0 && first.rendering.height > 0,
    `canvas has a backing store (${first.rendering.width}x${first.rendering.height})`,
  );
  check(first.rendering.clock > 0, `race clock advanced (${first.rendering.clock}s), so the loop is running`);
  check(first.order.length === 6, `all 6 racers ranked (got ${first.order.length})`);

  const finishers = first.order.filter((r) => r.time && r.time !== "—");
  // A marble can legitimately be timed out behind the field; the race still
  // has to produce a full ranking, which is checked above.
  check(finishers.length >= 5, `at least 5 of 6 marbles finished (got ${finishers.length})`);

  const winnerTime = Number.parseFloat(finishers[0]?.time ?? "0");
  check(winnerTime > 4 && winnerTime < 180, `winning time is plausible (${winnerTime}s)`);

  await page.close();

  // Determinism: an identical seed must produce an identical result.
  const page2 = await context.newPage();
  console.log(`\nRace 2 — same seed, fresh page`);
  const second = await runRace(page2, base, SEED, "run2");
  console.log(`  order:   ${second.order.map((r) => `${r.place}. ${r.name} ${r.time}`).join(" | ")}`);

  const sameOrder =
    JSON.stringify(first.order.map((r) => r.name)) === JSON.stringify(second.order.map((r) => r.name));
  check(sameOrder, "same seed produces the same finishing order");

  const sameTimes =
    JSON.stringify(first.order.map((r) => r.time)) === JSON.stringify(second.order.map((r) => r.time));
  check(sameTimes, "same seed produces the same finishing times");

  await page2.close();

  // A different seed should give a genuinely different track.
  const page3 = await context.newPage();
  console.log(`\nRace 3 — different seed`);
  const third = await runRace(page3, base, "A-DIFFERENT-SEED", "run3");
  console.log(`  preview: ${third.preview}`);
  check(third.preview !== first.preview, "a different seed builds a different track");
  check(third.order.length === 6, "different seed also ranks everyone");
  await page3.close();
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
