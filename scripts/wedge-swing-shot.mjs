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
  s.listen(4354, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  // Find a seed with a wedge obstacle first.
  let seed = null;
  let obstacleIndex = null;
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    for (let i = 0; i < 40; i++) {
      const trySeed = `WEDGE-SWING-${i}`;
      await page.goto(`http://127.0.0.1:4354/?seed=${trySeed}&players=Ana,Ben`, { waitUntil: "load" });
      await page.waitForSelector(".setup-screen", { timeout: 60000 });
      await page.click(".btn-start");
      await page.waitForSelector(".hud-screen", { timeout: 60000 });
      await page.waitForTimeout(200);
      const found = await page.evaluate(() => {
        const world = window.__world;
        const spec = world.plan.obstacles.find((o) => o.kind === "wedge");
        return spec ? spec.index : null;
      });
      if (found !== null) {
        seed = trySeed;
        obstacleIndex = found;
        break;
      }
    }
    await page.close();
  }
  console.log("seed:", seed, "obstacle index:", obstacleIndex);
  if (seed === null) throw new Error("no wedge found");

  for (const [label, waitMs] of [
    ["a", 0],
    ["b", 1000],
    ["c", 2000],
    ["d", 3000],
  ]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    page.on("pageerror", (e) => console.error("page error:", String(e)));
    await page.goto(`http://127.0.0.1:4354/?seed=${seed}&players=Ana,Ben`, { waitUntil: "load" });
    await page.waitForSelector(".setup-screen", { timeout: 60000 });
    await page.click(".btn-start");
    await page.waitForSelector(".hud-screen", { timeout: 60000 });
    await page.waitForFunction(() => {
      const el = document.querySelector(".countdown");
      return el && el.textContent === "";
    }, { timeout: 15000 });
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    await page.evaluate((obstacleIndex) => {
      const world = window.__world;
      world.engine.stopRenderLoop();
      const frame = world.geometry.frameAt(obstacleIndex);
      world.camera.snapTo(
        frame.position.add(frame.up.scale(10)).add(frame.tangent.scale(-12)).add(frame.right.scale(4)),
        frame.position.add(frame.up.scale(1)),
      );
      world.scene.render();
    }, obstacleIndex);
    await page.screenshot({ path: join(SHOT_DIR, `wedge-swing-${label}.png`) });
    await page.close();
  }

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
