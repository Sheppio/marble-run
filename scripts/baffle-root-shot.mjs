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
  s.listen(4352, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto(`http://127.0.0.1:4352/?seed=BAFFLE-ROOT-0&players=Ana,Ben`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });

  const obstacleIndex = await page.evaluate(() => {
    const world = window.__world;
    const spec = world.plan.obstacles.find((o) => o.kind === "baffles");
    return spec ? spec.index : null;
  });

  // Widest-angle extreme (maxAngle), close-up on the root/wall corner.
  await page.evaluate((obstacleIndex) => {
    const world = window.__world;
    world.engine.stopRenderLoop();
    world.obstacles.update(0);
    const frame = world.geometry.frameAt(obstacleIndex);
    world.camera.snapTo(
      frame.position.add(frame.up.scale(9)).add(frame.tangent.scale(-10)).add(frame.right.scale(1)),
      frame.position.add(frame.up.scale(0.8)).add(frame.right.scale(-frame.width * 0.8)),
    );
    world.scene.render();
  }, obstacleIndex);
  await page.screenshot({ path: join(SHOT_DIR, "baffle-root-wide.png") });

  console.log("shot in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
