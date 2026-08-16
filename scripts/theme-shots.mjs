/**
 * Screenshots each visual theme mid-race, so the look can be checked without
 * a phone in hand.
 *
 * Usage: node scripts/theme-shots.mjs [--seed SEED]
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const seedArg = args.indexOf("--seed");
const SEED = seedArg >= 0 ? args[seedArg + 1] : "THEME-SHOT";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/marble-shots";
const THEMES = ["Workshop", "Cartoon", "Neon"];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const file =
        url.pathname === "/" ? "dist/index.html" : join("dist", normalize(url.pathname));
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  s.listen(4321, () => resolve(s));
});

mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});

try {
  // A phone-shaped viewport, since that is the target device.
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
  page.on("pageerror", (e) => console.error("page error:", String(e)));

  for (const theme of THEMES) {
    await page.goto(
      `http://127.0.0.1:4321/?seed=${encodeURIComponent(SEED)}&players=Ana,Ben,Cleo,Dai,Eve,Fin`,
      { waitUntil: "load" },
    );
    await page.waitForSelector(".setup-screen", { timeout: 60000 });
    await page.click(`.btn-chip:text-is("${theme}")`);
    await page.waitForTimeout(300);
    const slug = theme.toLowerCase();
    await page.screenshot({ path: join(SHOT_DIR, `theme-${slug}-setup.png`) });

    await page.click(".btn-start");
    await page.waitForSelector(".hud-screen", { timeout: 60000 });
    // Mid-flythrough: the preview camera is high and wide, so this is the only
    // frame that shows the sky and the run as a whole object.
    await page.waitForTimeout(2600);
    await page.screenshot({ path: join(SHOT_DIR, `theme-${slug}-preview.png`) });
    // Then a frame once the field is racing.
    await page.waitForTimeout(13400);
    await page.screenshot({ path: join(SHOT_DIR, `theme-${slug}-race.png`) });
    console.log(`captured ${theme}`);
  }
} finally {
  await browser.close();
  server.close();
}
