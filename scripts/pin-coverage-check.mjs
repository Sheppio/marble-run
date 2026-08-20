/**
 * Confirms every generated track has at least one pin field, and reports
 * the average count — checks placeObstacles's guaranteed-fallback insertion
 * and the raised pin weight/eligibility actually land.
 *
 * Usage: node scripts/pin-coverage-check.mjs [--seeds 300]
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const SEEDS = readArg("seeds", 300);

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
  s.listen(4346, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4346/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.checkPinCoverage === "function", { timeout: 30000 });

  const result = await page.evaluate((seeds) => window.checkPinCoverage("PCOV", seeds), SEEDS);
  console.log(`${result.seeds} seeds checked`);
  console.log(`mean pin fields per track: ${result.meanPinFields.toFixed(2)}`);
  console.log(`seeds with zero pin fields: ${result.withoutPins.length}`);
  if (result.withoutPins.length > 0) {
    console.log("  ", result.withoutPins.slice(0, 10).join(", "));
  }
} finally {
  await browser.close();
  server.close();
}
