/**
 * Screenshot of the start gate seen from far down the track — as far as the
 * finish line, looking back — which is where a fixed-gap z-fight between the
 * gate box and its banner planes actually showed up: fine up close (the
 * angles gate-oblique-shot.mjs checks), a solid colour with only a sliver of
 * correct texture at range, because standard perspective depth precision
 * degrades with distance and a few centimetres of world-space separation
 * stops being enough to resolve reliably.
 *
 * Usage: node scripts/gate-distance-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "GATE-DISTANCE");
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
  s.listen(4337, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4337/?seed=${SEED}&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(3000);

  const distances = [60, 100, 160, 250, 400];
  for (const dist of distances) {
    await page.evaluate((d) => {
      const world = window.__world;
      const startFrame = world.geometry.frameAt(world.plan.startIndex + 2);
      world.engine.stopRenderLoop();
      // Standing d cm downstream of the gate, a little up, looking back at it
      // — the same relative angle the bug report's screenshot shows, at
      // increasing range.
      world.camera.snapTo(
        startFrame.position.add(startFrame.tangent.scale(d)).add(startFrame.up.scale(d * 0.12 + 10)),
        startFrame.position.add(startFrame.up.scale(1)),
      );
      world.scene.render();
    }, dist);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOT_DIR, `gate-distance-${dist}.png`) });
  }

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
