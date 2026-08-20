/**
 * Close screenshot of the toy boat, to check the hull/mast/sails look right
 * and that it's actually riding the water rather than floating dead flat
 * through it.
 *
 * Usage: node scripts/boat-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "BOAT-SHOT");
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/marble-shots";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml" };

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  s.listen(4336, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4336/?seed=${SEED}&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(3000);

  const found = await page.evaluate(() => {
    const world = window.__world;
    const boat = world.boats[0];
    if (!boat) return null;
    const p = boat.root.position;
    return { x: p.x, y: p.y, z: p.z };
  });
  console.log("boat position:", found);

  for (const [label, back, right, up] of [
    ["side", 3, 20, 7],
    ["close", 10, 14, 8],
    ["wide", 20, 26, 18],
  ]) {
    await page.evaluate(
      ({ back, right, up }) => {
        const world = window.__world;
        const boat = world.boats[0];
        const p = boat.root.position;
        // Recompute the boat's own heading from its orbit position (same
        // formula updateBoat uses), so the camera offset is relative to
        // which way the boat is actually facing rather than raw world axes
        // — a fixed-axis offset lines up with the hull by pure chance and
        // usually looks straight down its length instead of from the side.
        const angle = Math.atan2(p.z, p.x);
        const Vec = Object.getPrototypeOf(p).constructor;
        const forward = new Vec(-Math.sin(angle), 0, Math.cos(angle));
        const rightAxis = new Vec(Math.cos(angle), 0, Math.sin(angle));
        world.engine.stopRenderLoop();
        world.camera.snapTo(
          p
            .subtract(forward.scale(back))
            .add(rightAxis.scale(right))
            .add(new Vec(0, up, 0)),
          p,
        );
        world.scene.render();
      },
      { back, right, up },
    );
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOT_DIR, `boat-${label}.png`) });
  }

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
