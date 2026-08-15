/**
 * Drives the headless tuning harness and prints a report.
 *
 * Usage: node scripts/tune.mjs [--seeds 40] [--players 6]
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

const SEEDS = readArg("seeds", 30);
const PLAYERS = readArg("players", 6);
const PREFIX = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : "TUNE";

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
  s.listen(4320, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4320/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  const { reports, summary } = await page.evaluate(
    ([seeds, players, prefix]) => window.runDiagnostic({ seeds, players, seedPrefix: prefix }),
    [SEEDS, PLAYERS, PREFIX],
  );

  console.log(`\n=== ${SEEDS} races, ${PLAYERS} marbles each ===\n`);
  console.log(`finish rate                 ${(summary.finishRate * 100).toFixed(1)}% of marbles`);
  console.log(`races where everyone home   ${(summary.racesWhereEveryoneFinished * 100).toFixed(1)}%`);
  console.log(`winner time  median/min/max ${summary.medianWinnerTime.toFixed(1)}s / ${summary.minWinnerTime.toFixed(1)}s / ${summary.maxWinnerTime.toFixed(1)}s`);
  console.log(`rescues per race            ${summary.meanRescuesPerRace.toFixed(1)}`);
  console.log(`track  length/drop          ${summary.meanTrackLength.toFixed(1)}m / ${(summary.meanDrop * 100).toFixed(0)}cm`);
  console.log(`marble speed  mean/peak    ${summary.meanSpeed.toFixed(2)} m/s / ${summary.peakSpeed.toFixed(2)} m/s`);
  console.log(`build/sim cost per race     ${summary.meanBuildMs.toFixed(0)}ms / ${summary.meanSimMs.toFixed(0)}ms`);

  const bad = reports.filter((r) => r.finishers < r.fieldSize);
  if (bad.length) {
    console.log(`\nRaces with stragglers (${bad.length}):`);
    for (const r of bad.slice(0, 12)) {
      const stranded = r.strandedAt
        .map((p, i) => `${(p * 100).toFixed(0)}% (${r.strandedNear[i]})`)
        .join(", ");
      console.log(
        `  ${r.seed.padEnd(10)} ${r.finishers}/${r.fieldSize} home · ${r.trackLength.toFixed(1)}m/${(r.totalDrop * 100).toFixed(0)}cm drop · ${r.totalRescues} rescues · stranded at ${stranded}`,
      );
    }
  }

  // Where along the track do marbles get into trouble?
  const buckets = new Array(10).fill(0);
  let totalRescues = 0;
  for (const r of reports) {
    for (const p of r.rescuePoints) {
      buckets[Math.min(9, Math.max(0, Math.floor(p * 10)))]++;
      totalRescues++;
    }
  }
  if (totalRescues > 0) {
    console.log(`\nRescues by position along track (${totalRescues} total):`);
    buckets.forEach((count, i) => {
      const bar = "█".repeat(Math.round((count / Math.max(...buckets)) * 34));
      console.log(`  ${String(i * 10).padStart(3)}–${String(i * 10 + 10).padStart(3)}%  ${bar} ${count}`);
    });
  }
  // Which obstacles actually cause trouble?
  const byObstacle = {};
  const strandCounts = {};
  for (const r of reports) {
    for (const [kind, count] of Object.entries(r.rescuesByObstacle ?? {})) {
      byObstacle[kind] = (byObstacle[kind] ?? 0) + count;
    }
    for (const kind of r.strandedNear ?? []) {
      strandCounts[kind] = (strandCounts[kind] ?? 0) + 1;
    }
  }

  const byReason = {};
  for (const r of reports) {
    for (const [reason, count] of Object.entries(r.rescuesByReason ?? {})) {
      byReason[reason] = (byReason[reason] ?? 0) + count;
    }
  }
  const reasonSorted = Object.entries(byReason).sort((a, b) => b[1] - a[1]);
  if (reasonSorted.length) {
    console.log("\nRescues by trigger:");
    for (const [reason, count] of reasonSorted) {
      console.log(`  ${reason.padEnd(12)} ${String(count).padStart(4)}`);
    }
  }

  const lateral = reports.flatMap((r) => r.offTrackLateral ?? []);
  const vertical = reports.flatMap((r) => r.offTrackVertical ?? []);
  const inGap = reports.reduce((s, r) => s + (r.offTrackInGap ?? 0), 0);
  if (lateral.length) {
    const q = (arr, p) => {
      const sortedArr = [...arr].sort((a, b) => a - b);
      return sortedArr[Math.min(sortedArr.length - 1, Math.floor(p * sortedArr.length))];
    };
    console.log("\nOff-track rescues — distance from the channel centre:");
    console.log(`  lateral  p10 ${q(lateral, 0.1).toFixed(1)}m  median ${q(lateral, 0.5).toFixed(1)}m  p90 ${q(lateral, 0.9).toFixed(1)}m  max ${Math.max(...lateral).toFixed(1)}m`);
    console.log(`  vertical median ${q(vertical, 0.5).toFixed(1)}m  min ${Math.min(...vertical).toFixed(1)}m`);
    console.log(`  happened inside a jump gap: ${inGap} of ${lateral.length}`);
  }

  const sorted = Object.entries(byObstacle).sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    console.log("\nRescues by nearest obstacle:");
    for (const [kind, count] of sorted) {
      console.log(`  ${kind.padEnd(12)} ${String(count).padStart(4)}`);
    }
  }

  const strandSorted = Object.entries(strandCounts).sort((a, b) => b[1] - a[1]);
  if (strandSorted.length) {
    console.log("\nMarbles that never finished, by nearest obstacle:");
    for (const [kind, count] of strandSorted) {
      console.log(`  ${kind.padEnd(12)} ${String(count).padStart(4)}`);
    }
  }

  console.log("");
} finally {
  await browser.close();
  server.close();
}
