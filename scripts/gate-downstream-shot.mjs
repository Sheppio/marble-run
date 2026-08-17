/**
 * Screenshot of the start gate from the downstream side — a camera standing
 * past the gate looking back up the track at it, which is what the
 * "oncoming" camera mode (and simply looking backward) sees. Checks the
 * downstream-facing plane shows correct, non-mirrored text — a box's two
 * large faces share one texture through opposite halves of its default UV,
 * so without a dedicated plane for this side the word reads backwards here
 * even when the upstream face (checked by gate-shot.mjs) is correct.
 *
 * Usage: node scripts/gate-downstream-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "GATE-DOWN");
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
  s.listen(4329, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4329/?seed=${SEED}&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    const world = window.__world;
    const frame = world.geometry.frameAt(world.plan.startIndex + 2);
    world.engine.stopRenderLoop();
    // Standing downstream, past the gate, looking back up the track at it.
    world.camera.snapTo(
      frame.position.add(frame.tangent.scale(9)).add(frame.up.scale(4)),
      frame.position.add(frame.up.scale(1)),
    );
    world.scene.render();
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOT_DIR, "gate-downstream.png") });

  console.log("shot in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
