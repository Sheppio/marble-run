/**
 * Confirms every generated track is at least 10m long, across many seeds —
 * the floor `generateTrack` retries under to guarantee in src/track/generator.ts.
 *
 * Usage: node scripts/min-length-check.mjs [--seeds 500]
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
const SEEDS = readArg("seeds", 500);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml" };
const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  s.listen(4331, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4331/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  const { reports } = await page.evaluate(
    ([seeds, prefix]) => window.runDiagnostic({ seeds, players: 1, seedPrefix: prefix }),
    [SEEDS, "MINLEN"],
  );
  const lengths = reports.map((r) => r.trackLength);

  const min = Math.min(...lengths);
  const worstIndex = lengths.indexOf(min);
  console.log(`${lengths.length} seeds checked`);
  console.log(`shortest track: ${min.toFixed(2)}m (seed MINLEN-${worstIndex}, 0-indexed)`);
  console.log(`mean: ${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(2)}m`);
  console.log(min >= 10 ? "PASS: every track is at least 10m" : "FAIL: a track came in under 10m");
} finally {
  await browser.close();
  server.close();
}
