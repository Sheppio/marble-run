/**
 * Screenshots the results screen so the new auto-next button and layout can be
 * checked without playing a whole race by hand.
 *
 * Usage: node scripts/results-shot.mjs
 */
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
  s.listen(4323, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4323/?seed=RESULTS-SHOT&players=Ana,Ben,Cleo,Dai", { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForSelector(".results-screen", { timeout: 120000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOT_DIR, "results-off.png") });

  await page.click(".btn-auto-next");
  await page.waitForTimeout(1100);
  await page.screenshot({ path: join(SHOT_DIR, "results-on.png") });
  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
