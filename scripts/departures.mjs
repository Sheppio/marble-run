/** Classifies how marbles leave the channel. */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404).end("not found"); }
  });
  s.listen(4322, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4322/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  const { reports } = await page.evaluate(() =>
    window.runDiagnostic({ seeds: 16, players: 6, disableObstacles: true }),
  );

  const all = reports.flatMap((r) => r.departures ?? []);
  const classify = (d) => {
    if (d.up < -0.5) return "below the floor";
    if (d.up > d.wall) return "above the walls";
    if (Math.abs(d.side) > d.width) return "outside the walls, at channel height";
    return "inside the channel (detector misfire?)";
  };
  const counts = {};
  for (const d of all) counts[classify(d)] = (counts[classify(d)] ?? 0) + 1;

  console.log(`\n${all.length} departures, obstacles disabled:\n`);
  for (const [kind, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(30)} ${count}  (${((count / all.length) * 100).toFixed(0)}%)`);
  }

  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * s.length)] ?? 0; };
  console.log(`\n  side offset   median ${q(all.map((d) => Math.abs(d.side)), 0.5).toFixed(1)}cm   vs channel half-width ${q(all.map((d) => d.width), 0.5).toFixed(1)}cm`);
  console.log(`  up offset     median ${q(all.map((d) => d.up), 0.5).toFixed(1)}cm   vs wall height ${q(all.map((d) => d.wall), 0.5).toFixed(1)}cm`);
  const inGapTotal = reports.reduce((s, r) => s + (r.offTrackInGap ?? 0), 0);
  console.log(`  in a jump gap ${inGapTotal} of ${all.length}`);
  console.log(`  speed         median ${(q(all.map((d) => d.speed), 0.5) / 100).toFixed(2)}m/s  p90 ${(q(all.map((d) => d.speed), 0.9) / 100).toFixed(2)}m/s\n`);
} finally {
  await browser.close();
  server.close();
}
