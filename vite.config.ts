import { defineConfig } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// The version shown in the corner of the setup screen. package.json is the one
// place it lives; baking it in at build time means the running app and the
// repository can never disagree about which build is on screen.
const { version } = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

// `base` is set at build time so the same source works on a local dev server
// and under a GitHub Pages project path (https://user.github.io/marble-run/).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // The tuning harness ships alongside the app. It is a few kilobytes of
        // its own code and shares every other chunk, so it costs players
        // nothing and stays available for diagnosing a bad track later.
        diagnostic: resolve(__dirname, "diagnostic.html"),
      },
    },
  },
  server: {
    host: true,
  },
});
