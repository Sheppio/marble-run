/**
 * Screenshot of the start gate from a few oblique angles above and behind
 * it — the angles that showed a z-fighting bug between the gate box's own
 * (partly mirrored) face and the plane added in front of it to fix that
 * mirroring: both rendered at once and tore, frame to frame, as a
 * double-exposed "START". Square-on shots (gate-shot.mjs,
 * gate-downstream-shot.mjs) didn't catch it — the two surfaces only visibly
 * fight at an angle. Fixed by moving the banner onto its own planes and
 * leaving the box's own faces plain; this is what checks that stays fixed.
 *
 * Usage: node scripts/gate-oblique-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "GATE-OBLIQUE");
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
  s.listen(4335, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4335/?seed=${SEED}&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(3000);

  // A handful of angles/distances around the gate, all oblique rather than
  // square-on, since that is where z-fighting between near-coplanar surfaces
  // shows up worst.
  const offsets = [
    { back: 14, right: 10, up: 8, label: "a" },
    { back: 20, right: -14, up: 12, label: "b" },
    { back: 8, right: 6, up: 5, label: "c" },
  ];

  for (const o of offsets) {
    await page.evaluate((offset) => {
      const world = window.__world;
      const frame = world.geometry.frameAt(world.plan.startIndex + 2);
      world.engine.stopRenderLoop();
      world.camera.snapTo(
        frame.position
          .add(frame.tangent.scale(-offset.back))
          .add(frame.right.scale(offset.right))
          .add(frame.up.scale(offset.up)),
        frame.position.add(frame.up.scale(1)),
      );
      world.scene.render();
    }, o);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOT_DIR, `gate-oblique-${o.label}.png`) });
  }

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
