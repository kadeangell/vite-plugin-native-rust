import { defineConfig } from "vite";

import { rustPlugin } from "vite-plugin-native-rust";

// The cache dir and log level are driven per test run via env so the suite can
// assert cold/warm compiles in isolation and spot-check the options surface.
const cacheDir = process.env.RUST_CACHE_DIR || undefined;
const logLevel =
  process.env.RUST_LOG_LEVEL === "silent" ? "silent" : undefined;

export default defineConfig({
  plugins: [rustPlugin({ cacheDir, logLevel })],
  build: {
    ssr: "src/server.ts",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: "server.js" },
    },
  },
});
