/**
 * Screenshot of the start gate from the actual camera framing the countdown
 * uses (`gridFraming()`), pulled in closer along the same line so the
 * "START" banner is legible. Exists to check the banner reads right-way-up
 * and un-mirrored after a change to `startBannerTexture`.
 *
 * Usage: node scripts/gate-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "GATE-SHOT");
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
  s.listen(4326, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4326/?seed=${SEED}&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    const world = window.__world;
    world.engine.stopRenderLoop();
    const { eye, look } = world.camera.gridFraming();
    // Same line of sight as the real countdown shot, just pulled closer.
    const closerEye = eye.add(look.subtract(eye).scale(0.45));
    world.camera.snapTo(closerEye, look);
    world.scene.render();
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOT_DIR, "gate-check.png") });

  console.log("shot in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
