/**
 * Checks the "downhill everywhere" invariant: a marble set down at rest
 * anywhere on the track must start rolling towards the finish.
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
  s.listen(4326, () => resolve(s));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

const SEEDS = Number(process.argv[2] ?? 10);
const SETTLE = Number(process.argv[3] ?? 2.5);

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", String(e)));
  await page.goto("http://127.0.0.1:4326/diagnostic.html", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.restTest === "function", { timeout: 30000 });

  console.log("\n seed        rest points rolling   min slope   rising pts   stuck at");
  console.log(" " + "-".repeat(74));

  let totalTested = 0;
  let totalRolled = 0;
  let worstSlope = Infinity;
  let totalRising = 0;
  const stuckKinds = {};

  for (let i = 0; i < SEEDS; i++) {
    const result = await page.evaluate(([seed, settle]) => window.restTest(seed, 40, settle), [`REST-${i}`, SETTLE]);
    totalTested += result.tested;
    totalRolled += result.rolled;
    worstSlope = Math.min(worstSlope, result.minSlopeDegrees);
    totalRising += result.risingPoints;
    const stuck =
      result.stuckAt.map((f, j) => `${(f * 100).toFixed(0)}% (${result.stuckOn[j]})`).join(", ") || "—";
    for (const kind of result.stuckOn ?? []) stuckKinds[kind] = (stuckKinds[kind] ?? 0) + 1;
    console.log(
      ` REST-${String(i).padEnd(6)} ${String(result.rolled).padStart(3)}/${String(result.tested).padEnd(3)}       ${result.minSlopeDegrees.toFixed(2).padStart(6)}°   ${String(result.risingPoints).padStart(6)}       ${stuck}`,
    );
  }

  console.log(
    `\n ${totalRolled}/${totalTested} rest points roll away (${((totalRolled / totalTested) * 100).toFixed(1)}%)`,
  );
  console.log(` shallowest gradient anywhere: ${worstSlope.toFixed(2)}°`);
  console.log(` centreline points that rise:  ${totalRising}`);
  const kinds = Object.entries(stuckKinds).sort((a, b) => b[1] - a[1]);
  if (kinds.length) {
    console.log(" stuck points were sitting on:");
    for (const [kind, count] of kinds) console.log(`   ${kind.padEnd(14)} ${count}`);
  }
  console.log("");
} finally {
  await browser.close();
  server.close();
}
