import { defineConfig } from "vite";
import { resolve } from "node:path";

// `base` is set at build time so the same source works on a local dev server
// and under a GitHub Pages project path (https://user.github.io/marble-run/).
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
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
