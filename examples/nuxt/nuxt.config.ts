import { rustPlugin } from "vite-plugin-native-rust";
import { nitroRustPlugin, nitroShipAddons } from "vite-plugin-native-rust/nitro";

// Nuxt runs TWO build pipelines, and the Rust plugin must be registered in
// each one it should serve:
//
//  - `vite.plugins` covers the app layer: pages, components, and Nuxt plugins,
//    across the client build, the SSR build, and the dev server. The plugin's
//    `options.ssr` gate keeps `.rs` imports out of the client bundle — only
//    server-only app code (here: `app/plugins/rust.server.ts`) may import Rust.
//  - `nitro.rollupConfig.plugins` covers the `server/` directory (API routes,
//    middleware), which Nitro bundles with its own Rollup pass that never sees
//    Vite plugins. `nitroRustPlugin()` (from the plugin's `/nitro` subpath)
//    adapts the same plugin for that pass: it forces the server context on
//    `load` (raw Rollup passes no `{ ssr }`), repairs the file-URL tokens that
//    Nitro's `import.meta` shim mangles, and neutralizes the chunk-sibling
//    recovery that inverts into dead weight under Nitro's entry-relative
//    runtime. See the plugin's docs/nitro.md for the full reasoning.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",

  vite: {
    plugins: [rustPlugin()],
  },

  nitro: {
    rollupConfig: {
      // Must come FIRST (before Nitro's own plugins) so `.rs` specifiers are
      // claimed before node-resolve treats raw Rust source as JavaScript.
      plugins: [nitroRustPlugin()],
    },
    // Guarantee the APP-LAYER (Vite-side) addon travels into `.output`:
    // `nuxt build` runs the Vite SSR build first — the plugin emits the
    // compiled `.node` beside `server.mjs` in `.nuxt/dist/server/` — and Nitro
    // then re-bundles that server entry into `.output/server/chunks/` without
    // knowing about assets Vite emitted. This Nitro module copies any
    // app-layer `.node` to the output-server root on the `compiled` hook —
    // exactly where the surviving entry-relative
    // `new URL("<name>.node", globalThis._importMeta_.url)` reference
    // resolves. (In this example the `server/api/rust.ts` route imports the
    // same crate, so Nitro's own pass already emits an identically named
    // asset at that spot — the module keeps the app layer correct on its own,
    // e.g. if the API route is ever removed.)
    modules: [nitroShipAddons({ from: ".nuxt/dist/server" })],
    typescript: {
      tsConfig: {
        compilerOptions: { allowArbitraryExtensions: true },
      },
    },
    // Pin the Vercel function runtime (default would be keyed off the local
    // Node major, which may be unsupported — e.g. Node 25 → nodejs22.x).
    // 24.x matches the other examples and the Vercel build image the addon is
    // compiled on.
    vercel: {
      functions: { runtime: "nodejs24.x" },
    },
  },

  // Nuxt generates project-reference tsconfigs under `.nuxt/`;
  // `allowArbitraryExtensions` lets TypeScript resolve the plugin-generated
  // `native/src/lib.d.rs.ts` for the `.rs` import in both the app project
  // (app/plugins/rust.server.ts) and the Nitro project (server/api/rust.ts).
  typescript: {
    tsConfig: {
      compilerOptions: { allowArbitraryExtensions: true },
    },
  },
});
