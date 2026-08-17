/**
 * Asks whether a queue of marbles on a baffle is harder to shift than one.
 *
 * The intuition is that marbles behind press the leader into the baffle face,
 * and since Coulomb friction there scales with the normal force while the
 * gravity driving the escape does not, a queue ought to jam where one marble
 * would get away. This measures it directly: the same baffle, from rest, with
 * one to four marbles stacked nose to tail against it. It also reports the
 * descent at the baffle, which is the other term in that balance.
 *
 * The answer, over 24 seeds, is that neither explains it — see the comment on
 * BAFFLE_LEAN in src/track/obstacles.ts.
 *
 * Usage: node scripts/baffle-queue.mjs
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".wasm":"application/wasm", ".json":"application/json" };
const server = await new Promise((r) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file = url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch { if (!res.headersSent) res.writeHead(404).end("nf"); }
  });
  s.listen(4355, () => r(s));
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox","--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", String(e).slice(0,140)));
await page.goto("http://127.0.0.1:4355/diagnostic.html", { waitUntil: "load" });
await page.waitForFunction(() => typeof window.baffleQueueTest === "function", { timeout: 30000 });
const tally = {};
const stalledSeeds = [];
const grads = [];
for (let i = 1; i <= 24; i++) {
  const seed = `Q-${i}`;
  const r = await page.evaluate((s) => window.baffleQueueTest(s, 4, 6), seed);
  const stalled = r.results.some((x) => !x.escaped);
  if (r.results.length) grads.push({ seed, g: r.gradientDegrees, stalled });
  if (stalled) {
    stalledSeeds.push(`${seed}: ${r.gradientDegrees.toFixed(2)} deg  ` + r.results.map((x) => `${x.queue}=${x.escaped ? "go" : "STUCK"}`).join(" "));
  }
  for (const x of r.results) (tally[x.queue] ||= []).push(x.escaped);
}
console.log("\n  seeds where any queue length stalled:");
for (const l of stalledSeeds) console.log("   ", l);
const bad = grads.filter((x) => x.stalled).map((x) => x.g);
const good = grads.filter((x) => !x.stalled).map((x) => x.g);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(`\n  gradient at baffle, stalled seeds: ${bad.map((g) => g.toFixed(2)).join(", ")}`);
console.log(`  gradient at baffle, clean seeds:   mean ${mean(good).toFixed(2)} deg, min ${Math.min(...good).toFixed(2)}`);
console.log("\n  escape rate by queue length:");
for (const k of Object.keys(tally).sort()) {
  const v = tally[k];
  console.log(`    ${k} marble(s): ${v.filter(Boolean).length}/${v.length}`);
}
await browser.close();
server.close();
