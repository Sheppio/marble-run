/**
 * Screenshots the start of a race, and reports the shadow frustum's density.
 *
 * Two things this is for. The gate: marbles should be packed against the bar
 * during the countdown and away the moment it lifts, which is easier to see in
 * three frames than to reason about. And the shadow: the frustum is now sized
 * once from the run's bounds, so this prints how many centimetres of run each
 * shadow-map texel has to cover — the number that decides whether a fixed
 * frustum is affordable.
 *
 * Usage: node scripts/start-shots.mjs [--seed SEED] [--players N]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SEEDS = readArg("seed", "START-SHOT").split(",");
const PLAYER_COUNT = Number(readArg("players", "8"));
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/marble-shots";

const NAMES = ["Ana", "Ben", "Cleo", "Dai", "Eve", "Fin", "Gus", "Hana", "Ivo", "Jo", "Kit", "Lou"];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file =
        url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  s.listen(4322, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  for (const seed of SEEDS) {
    const roster = NAMES.slice(0, PLAYER_COUNT).join(",");
    await page.goto(
      `http://127.0.0.1:4322/?seed=${encodeURIComponent(seed)}&players=${roster}`,
      { waitUntil: "load" },
    );
    await page.waitForSelector(".setup-screen", { timeout: 60000 });
    await page.click(".btn-start");
    await page.waitForSelector(".hud-screen", { timeout: 60000 });

    // The sweep runs 1.8s and the return 0.9s, so the countdown owns the camera
    // from about 2.7s. Catch the grid mid-countdown, packed against the gate.
    await page.waitForTimeout(4200);
    await page.screenshot({ path: join(SHOT_DIR, `start-${seed}-grid.png`) });

    // A moment after the flag: the bar should be on its way up and the field
    // moving as a pack.
    await page.waitForTimeout(1900);
    await page.screenshot({ path: join(SHOT_DIR, `start-${seed}-away.png`) });

    // Well down the run, where a camera-following shadow frustum used to leave
    // a boundary sweeping along ahead of the leader.
    await page.waitForTimeout(9000);
    await page.screenshot({ path: join(SHOT_DIR, `start-${seed}-mid.png`) });

    const stats = await page.evaluate(() => {
      const world = window.__world;
      if (!world) return null;
      const light = world.scene.getLightByName("sun");
      const gen = light?.getShadowGenerator?.();
      const map = gen?.getShadowMap?.();
      const frames = world.geometry.frames;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const f of frames) {
        minX = Math.min(minX, f.position.x); maxX = Math.max(maxX, f.position.x);
        minZ = Math.min(minZ, f.position.z); maxZ = Math.max(maxZ, f.position.z);
      }
      return {
        width: light ? light.orthoRight - light.orthoLeft : null,
        height: light ? light.orthoTop - light.orthoBottom : null,
        mapSize: map ? map.getSize().width : null,
        footprint: [maxX - minX, maxZ - minZ],
        casters: map?.renderList?.length ?? 0,
      };
    });

    if (stats) {
      const cmPerTexel = Math.max(stats.width, stats.height) / stats.mapSize;
      console.log(
        `${seed}: run footprint ${stats.footprint[0].toFixed(0)}x${stats.footprint[1].toFixed(0)}cm · ` +
          `frustum ${stats.width.toFixed(0)}x${stats.height.toFixed(0)}cm · map ${stats.mapSize} · ` +
          `${cmPerTexel.toFixed(3)}cm per texel · ${stats.casters} casters`,
      );
    } else {
      console.log(`${seed}: no world handle`);
    }
  }
  console.log(`shots in ${SHOT_DIR}`);
} finally {
  await browser.close();
  server.close();
}
