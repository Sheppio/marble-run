/**
 * Sweeps the channel lip geometry.
 *
 * The lip trades three things off against each other: how reliably marbles
 * stay on the track, how much speed they keep, and how open the channel looks.
 * This finds the corner of that trade-off worth shipping.
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
  s.listen(4323, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

const CASES = [];
for (const width of [0.85, 1.05]) {
  for (const [fraction, sweep] of [[0.26, 112], [0.34, 118], [0.42, 120]]) {
    CASES.push({ width, fraction, sweep });
  }
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4323/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  console.log("\n width  lip(r/deg)   finish%  everyone%  rescues  winner(med)  openTop");
  console.log(" " + "-".repeat(72));

  for (const c of CASES) {
    const { summary } = await page.evaluate(
      ([w, f, sw]) =>
        window.runDiagnostic({ seeds: 14, players: 6, baseWidth: w, lipFraction: f, lipSweepDegrees: sw }),
      [c.width, c.fraction, c.sweep],
    );
    const reach = c.width * c.fraction * (1 - Math.cos((c.sweep * Math.PI) / 180));
    const openTop = c.width * 2 - 2 * reach;
    console.log(
      ` ${c.width.toFixed(2)}   ${c.fraction.toFixed(2)}/${String(c.sweep).padStart(3)}     ${(summary.finishRate * 100).toFixed(1).padStart(6)}  ${(summary.racesWhereEveryoneFinished * 100).toFixed(0).padStart(8)}  ${summary.meanRescuesPerRace.toFixed(1).padStart(7)}  ${summary.medianWinnerTime.toFixed(1).padStart(10)}s  ${openTop.toFixed(2)}m`,
    );
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
