/**
 * Screenshots the new "reverse" (oncoming) broadcast camera mode mid-race, to
 * check it frames an approaching marble sensibly and that the camera-mode
 * button cycles into it correctly.
 *
 * Usage: node scripts/reverse-cam-shot.mjs [--seed SEED]
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
const SEED = readArg("seed", "REVCAM");
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
  s.listen(4327, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  await page.goto(`http://127.0.0.1:4327/?seed=${SEED}&players=Ana,Ben,Cleo,Dai,Eve,Fin`, { waitUntil: "load" });
  await page.waitForSelector(".setup-screen", { timeout: 60000 });
  await page.click(".btn-start");
  await page.waitForSelector(".hud-screen", { timeout: 60000 });
  await page.waitForTimeout(5000); // clear the countdown/flythrough

  // Cycle: broadcast -> reverse
  await page.click(".btn-hud");
  await page.waitForTimeout(100);
  const label = await page.textContent(".btn-hud");
  console.log("camera button now reads:", label?.trim());

  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SHOT_DIR, "reverse-cam-1.png") });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(SHOT_DIR, "reverse-cam-2.png") });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(SHOT_DIR, "reverse-cam-3.png") });

  console.log("shots in", SHOT_DIR);
} finally {
  await browser.close();
  server.close();
}
