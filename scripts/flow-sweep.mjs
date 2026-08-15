/**
 * Sweeps gradient against rolling resistance.
 *
 * These are the two numbers that set how the run flows, and they fight each
 * other: more resistance needs a steeper track to keep marbles moving, and a
 * steeper track makes them faster. The pair has to be chosen together.
 */
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
  s.listen(4324, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

const CASES = [];
for (const resistance of [0.015, 0.03, 0.045]) {
  for (const pitch of [0.5, 0.7, 1.0]) CASES.push({ resistance, pitch });
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4324/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  console.log("\n  Crr  pitch   finish%  rescues  stalls  mean m/s  peak m/s  race(s)  drop  len");
  console.log(" " + "-".repeat(80));

  for (const c of CASES) {
    const { reports, summary } = await page.evaluate(
      ([r, p]) => window.runDiagnostic({ seeds: 12, players: 6, rollingResistance: r, pitchScale: p }),
      [c.resistance, c.pitch],
    );
    const stalls = reports.reduce((s, r) => s + (r.rescuesByReason?.["no-progress"] ?? 0), 0);
    console.log(
      ` ${c.resistance.toFixed(3)}  ${c.pitch.toFixed(2)}   ${(summary.finishRate * 100).toFixed(1).padStart(6)}  ${summary.meanRescuesPerRace.toFixed(1).padStart(7)}  ${String(stalls).padStart(6)}  ${summary.meanSpeed.toFixed(2).padStart(8)}  ${summary.peakSpeed.toFixed(2).padStart(8)}  ${summary.medianWinnerTime.toFixed(0).padStart(7)}  ${(summary.meanDrop * 100).toFixed(0).padStart(4)}cm ${summary.meanTrackLength.toFixed(1)}m`,
    );
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
