/**
 * Sweeps the baffle sweep angle and reports what each value costs.
 *
 * Baffles are the obstacle that causes by far the most stalls, and the angle
 * they present to oncoming marbles is the main thing deciding whether a marble
 * is guided along the face or comes to rest against it. Which direction that
 * cuts is not obvious from the geometry — a face closer to square across the
 * channel stops marbles more directly, but a face swept far downstream makes a
 * tighter pocket where it meets the wall it grows from — so it is measured.
 *
 * Usage: node scripts/baffle-sweep.mjs [--seeds 60] [--angles 0.1,0.2,0.3]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const SEEDS = Number(readArg("seeds", 60));
const PLAYERS = Number(readArg("players", 6));
const ANGLES = readArg("angles", "0.10,0.18,0.24,0.30").split(",").map(Number);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  s.listen(4324, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  console.log(`\n=== baffle sweep · ${SEEDS} seeds × ${PLAYERS} marbles per angle ===\n`);
  console.log("  angle    finish   all home   rescues   baffle-stalls   median win");
  console.log("  " + "-".repeat(66));

  for (const angle of ANGLES) {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("page error:", String(e)));
    // Set before the bundle runs, so the override is in place by the time the
    // first track is built.
    await page.addInitScript((a) => {
      window.__tuning = { baffleLean: a };
    }, angle);
    await page.goto("http://127.0.0.1:4324/diagnostic.html", { waitUntil: "load" });
    await page.waitForFunction(() => typeof window.runDiagnostic === "function", {
      timeout: 30000,
    });

    const { reports, summary } = await page.evaluate(
      ([seeds, players]) => window.runDiagnostic({ seeds, players, seedPrefix: "TUNE" }),
      [SEEDS, PLAYERS],
    );

    // Rescues and non-finishes blamed on a baffle: the number this is trying
    // to move. Everything else is context for whether the fix cost anything.
    let baffleTrouble = 0;
    for (const r of reports) {
      baffleTrouble += r.rescuesByObstacle?.baffles ?? 0;
      for (const near of r.strandedNear ?? []) if (near === "baffles") baffleTrouble++;
    }

    const deg = ((angle * 180) / Math.PI).toFixed(1);
    console.log(
      `  ${angle.toFixed(2)} (${deg}°)`.padEnd(13) +
        `${(summary.finishRate * 100).toFixed(1)}%`.padEnd(9) +
        `${(summary.racesWhereEveryoneFinished * 100).toFixed(1)}%`.padEnd(11) +
        `${summary.meanRescuesPerRace.toFixed(1)}`.padEnd(10) +
        `${baffleTrouble}`.padEnd(16) +
        `${summary.medianWinnerTime.toFixed(1)}s`,
    );
    await page.close();
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
