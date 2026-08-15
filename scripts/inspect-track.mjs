/** Prints what the generator actually laid down for a few seeds. */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm" };
const server = await new Promise((r) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404).end("x"); }
  });
  s.listen(4327, () => r(s));
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e)));
await page.goto("http://127.0.0.1:4327/diagnostic.html", { waitUntil: "load" });
await page.waitForFunction(() => typeof window.runSeed === "function");
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ["DAILY-2026-08-15", "INSPECT-1", "INSPECT-2"];
const out = await page.evaluate(async (list) => {
  await window.runDiagnostic({ seeds: 1, players: 2, maxSimSeconds: 1 });
  const results = [];
  for (const seed of list) {
    await window.runSeed(seed, 2, 1);
    results.push({ seed, ...window.__lastPlan });
  }
  return results;
}, seeds);
for (const r of out) {
  console.log(`\n${r.seed}: ${(r.length / 100).toFixed(1)}m, ${(r.drop).toFixed(0)}cm drop, ${r.segmentCount} segments`);
  console.log(`  ${r.segments.join(" → ")}`);
}
console.log("");
await browser.close();
server.close();
