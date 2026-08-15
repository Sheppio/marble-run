/**
 * Separates how much of the marbles' speed comes from physics and how much
 * from the drag ceiling.
 *
 * Speed here has four sources: the gradient (real gravity on real geometry),
 * rolling resistance, energy lost to collisions with walls, obstacles and other
 * marbles, and an artificial drag ceiling. Only the last of those is a choice
 * rather than a consequence, and it is worth being able to say exactly how much
 * work it is doing — the answer turned out to be less than expected, because
 * wall friction round the bends absorbs more than the ceiling ever does.
 *
 * Run with: npm run tune:speed
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

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
  s.listen(4330, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

const SEEDS = Number(process.argv[2] ?? 8);

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4330/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.runDiagnostic === "function", { timeout: 30000 });

  const cases = [
    ["ceiling as shipped", undefined],
    // A ceiling this high makes the drag term vanish, leaving gravity, rolling
    // resistance and collisions to settle the speed on their own.
    ["ceiling effectively removed", 100000],
  ];

  console.log(`\n ${SEEDS} seeds, 6 marbles each\n`);
  console.log(" case                          mean      peak     winner");
  console.log(" " + "-".repeat(52));

  for (const [label, cap] of cases) {
    const { summary } = await page.evaluate(
      ([seeds, c]) => window.runDiagnostic({ seeds, players: 6, maxSpeed: c }),
      [SEEDS, cap],
    );
    console.log(
      ` ${label.padEnd(28)} ${summary.meanSpeed.toFixed(2)} m/s  ${summary.peakSpeed.toFixed(2)} m/s  ${summary.medianWinnerTime.toFixed(0)}s`,
    );
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
