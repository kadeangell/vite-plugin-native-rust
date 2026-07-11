import { defineConfig } from "tsup";

// Bundle the plugin sources (which import each other with explicit `.ts`
// extensions for node's type-stripping in tests) into a single clean ESM file
// plus a `.d.ts`. esbuild resolves the `.ts` specifiers and emits `.js`, so the
// shipped dist never depends on being transpiled by a consumer's Vite.
export default defineConfig({
  // `src/nitro.ts` is the `vite-plugin-native-rust/nitro` subpath (Nitro 2.x
  // adapter). It imports from index.ts; esm code-splitting shares that code
  // in a common chunk instead of duplicating the plugin.
  //
  // `src/broker-child.ts` is the spawn-broker sidecar (issue #8): its own entry
  // (→ `dist/broker-child.js`), forked by the plugin via an absolute path and
  // deliberately NOT a package export — it is an internal runtime artifact.
  entry: ["src/index.ts", "src/nitro.ts", "src/broker-child.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: false,
  // Type-only import of `vite`; no runtime deps to externalize beyond node
  // builtins, which tsup/esbuild leave external automatically on node platform.
});
