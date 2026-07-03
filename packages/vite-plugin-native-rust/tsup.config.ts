import { defineConfig } from "tsup";

// Bundle the plugin sources (which import each other with explicit `.ts`
// extensions for node's type-stripping in tests) into a single clean ESM file
// plus a `.d.ts`. esbuild resolves the `.ts` specifiers and emits `.js`, so the
// shipped dist never depends on being transpiled by a consumer's Vite.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  // Type-only import of `vite`; no runtime deps to externalize beyond node
  // builtins, which tsup/esbuild leave external automatically on node platform.
});
