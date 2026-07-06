import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { rustPlugin } from "vite-plugin-native-rust";

import { rustPluginForNitro } from "./nitro-rust";

// Nuxt runs TWO build pipelines, and the Rust plugin must be registered in
// each one it should serve:
//
//  - `vite.plugins` covers the app layer: pages, components, and Nuxt plugins,
//    across the client build, the SSR build, and the dev server. The plugin's
//    `options.ssr` gate keeps `.rs` imports out of the client bundle — only
//    server-only app code (here: `app/plugins/rust.server.ts`) may import Rust.
//  - `nitro.rollupConfig.plugins` covers the `server/` directory (API routes,
//    middleware), which Nitro bundles with its own Rollup pass that never sees
//    Vite plugins. `rustPluginForNitro()` (./nitro-rust.ts) adapts the same
//    plugin for that pass.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",

  vite: {
    plugins: [rustPlugin()],
  },

  nitro: {
    rollupConfig: {
      // Must come before Nitro's own plugins so `.rs` specifiers are claimed
      // before node-resolve treats raw Rust source as JavaScript.
      plugins: [rustPluginForNitro()],
    },
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

  modules: [
    /**
     * Guarantee the APP-LAYER (Vite-side) addon travels into `.output`.
     *
     * `nuxt build` runs the Vite SSR build first — the plugin emits the
     * compiled `.node` beside `server.mjs` in `<buildDir>/dist/server/` — and
     * Nitro then re-bundles that server entry into `.output/server/chunks/`.
     * Nitro's Rollup pass knows nothing about assets Vite emitted, so the
     * addon would be left behind. The runtime reference survives as
     * `new URL("<name>.node", globalThis._importMeta_.url)`, which Nitro
     * resolves against the server ENTRY's directory — so one copy of each
     * addon at the output-server root makes the app-layer import work.
     *
     * (In this example the `server/api/rust.ts` route imports the same crate,
     * so Nitro's own pass already emits an identically-named asset at that
     * exact spot — but this hook keeps the app layer correct on its own, e.g.
     * if the API route is ever removed.)
     */
    function rustAddonGuarantee(_options: unknown, nuxt: any) {
      nuxt.hook("nitro:init", (nitro: any) => {
        nitro.hooks.hook("compiled", () => {
          const viteServerDir = join(nuxt.options.buildDir, "dist", "server");
          const outServerDir: string = nitro.options.output.serverDir;
          if (!existsSync(viteServerDir) || !existsSync(outServerDir)) return;
          for (const file of readdirSync(viteServerDir)) {
            if (!file.endsWith(".node")) continue;
            const dest = join(outServerDir, file);
            if (existsSync(dest)) continue;
            mkdirSync(outServerDir, { recursive: true });
            copyFileSync(join(viteServerDir, file), dest);
            console.log(
              `[example-nuxt] copied app-layer addon ${file} → .output/server/`,
            );
          }
        });
      });
    },
  ],

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
