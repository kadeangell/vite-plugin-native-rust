import { defineConfig } from "vite";

import { rustPlugin } from "vite-plugin-native-rust";

const cacheDir = process.env.RUST_CACHE_DIR || undefined;

// A *client* build whose entry reaches a `.rs` import. The plugin's load hook
// sees `ssr: false` and must fail with the friendly server-side error rather
// than leak a native addon toward the browser bundle.
export default defineConfig({
  plugins: [rustPlugin({ cacheDir })],
  build: {
    outDir: "dist-leak",
    emptyOutDir: true,
    lib: {
      entry: "src/leak-entry.ts",
      formats: ["es"],
      fileName: "leak",
    },
  },
});
