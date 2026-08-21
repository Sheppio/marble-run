import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";

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
  s.listen(4350, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  // One fresh page load per checkpoint, waiting a different amount of real
  // time after the race starts — the sim is deterministic for a given seed,
  // so this reliably samples the oscillation at each point without fighting
  // the physics-observable that would otherwise overwrite a manually forced
  // simTime the moment another frame renders.
  for (const [label, waitMs] of [
    ["a", 0],
    ["b", 1000],
    ["c", 2000],
    ["d", 3000],
    ["e", 4000],
  ]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    page.on("pageerror", (e) => console.error("page error:", String(e)));

    await page.goto(`http://127.0.0.1:4350/?seed=BAFFLE-SWING-0&players=Ana,Ben`, { waitUntil: "load" });
    await page.waitForSelector(".setup-screen", { timeout: 60000 });
    await page.click(".btn-start");
    await page.waitForSelector(".hud-screen", { timeout: 60000 });

    const obstacleIndex = await page.evaluate(() => {
      const world = window.__world;
      const spec = world.plan.obstacles.find((o) => o.kind === "baffles");
      return spec ? spec.index : null;
    });

    // 3300ms clears the countdown so the race has actually started (simTime
    // resets near 0 there); waitMs then samples the oscillation at t≈waitMs/1000.
    await page.waitForTimeout(4500 + waitMs);

    await page.evaluate((obstacleIndex) => {
      const world = window.__world;
      world.engine.stopRenderLoop();
      const frame = world.geometry.frameAt(obstacleIndex);
      world.camera.snapTo(
        frame.position.add(frame.up.scale(12)).add(frame.tangent.scale(-14)).add(frame.right.scale(6)),
        frame.position.add(frame.up.scale(1)),
      );
      world.scene.render();
    }, obstacleIndex);
    await page.screenshot({ path: join(SHOT_DIR, `baffle-swing-${label}.png`) });
    await page.close();
  }

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
