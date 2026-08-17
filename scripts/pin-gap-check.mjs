/**
 * Confirms the wall-hugging pin fix actually closes the side lane of a grid
 * pin field: reports the worst-case gap between the outermost pin (including
 * the wall pin) and the true channel wall, across many seeds. If that gap is
 * ever >= a marble's own diameter, a marble can still get down the side of
 * that row untouched.
 *
 * Usage: node scripts/pin-gap-check.mjs [--seeds 300]
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
  s.listen(4325, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4325/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.checkPinWallGaps === "function", { timeout: 30000 });

  const result = await page.evaluate((seeds) => window.checkPinWallGaps("PGAP", seeds), SEEDS);
  console.log(`${result.rows} grid pin rows checked across ${SEEDS} seeds`);
  console.log(`worst wall-side gap: ${result.worstGapCm.toFixed(2)}cm (seed ${result.worstSeed})`);
  console.log(`marble diameter: 1.60cm`);
  console.log(`sides with a gap >= marble diameter (skippable): ${result.overMarbleWidth}`);
} finally {
  await browser.close();
  server.close();
}
