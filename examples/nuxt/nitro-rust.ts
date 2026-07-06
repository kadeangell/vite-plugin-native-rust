/**
 * Adapter that makes `rustPlugin()` usable inside Nitro's raw Rollup pass.
 *
 * Nuxt splits its build in two: Vite handles the app layer (pages, components,
 * plugins and their SSR bundle), while everything under `server/` (API routes,
 * middleware) is bundled by Nitro with its own Rollup pipeline. `rustPlugin()`
 * is hook-compatible with plain Rollup, but three Vite/Nitro-isms need
 * adapting (all verified empirically against Nuxt 4.4 / Nitro 2.13):
 *
 * 1. **The ssr gate.** The plugin's `load` hook rejects any load where
 *    `options.ssr !== true` — that gate is what stops a `.rs` import leaking
 *    into a browser bundle. Vite passes `{ ssr }` as `load`'s second argument;
 *    raw Rollup passes nothing, so every load would be rejected as
 *    "client-side". Nitro's Rollup pass builds server-only code by definition
 *    (nothing it bundles can reach the browser), so forcing `ssr: true` here
 *    preserves the gate's intent exactly.
 *
 * 2. **Nitro's `import.meta` shimming breaks `ROLLUP_FILE_URL_*` tokens.**
 *    In build mode the plugin references the emitted `.node` addon through
 *    Rollup's `import.meta.ROLLUP_FILE_URL_<ref>` mechanism. Nitro registers
 *    `@rollup/plugin-replace` with `"import.meta." → "globalThis._importMeta_."`,
 *    and that replacement runs at *transform* time — before Rollup parses the
 *    module — so Rollup never sees the token and never resolves it. The chunk
 *    would ship a literal `globalThis._importMeta_.ROLLUP_FILE_URL_<ref>`
 *    (undefined at runtime → crash on first request). The `renderChunk` hook
 *    below repairs it: each mangled token is rewritten to
 *    `new URL("<asset-file-name>", globalThis._importMeta_.url)`. Nitro's
 *    runtime sets `globalThis._importMeta_.url` to the *entry* module's URL,
 *    and Rollup writes the emitted asset at the output root — the entry's own
 *    directory — so the entry-relative asset file name resolves correctly from
 *    every chunk. (A chunk-relative `import.meta.url` rewrite is not an
 *    option: the replace plugin runs again at renderChunk time, after this
 *    plugin, and would re-mangle it.)
 *
 * 3. **`enforce: "pre"` is a Vite concept.** Rollup runs plugins in array
 *    order, so this plugin must be placed FIRST in
 *    `nitro.rollupConfig.plugins` — before Nitro's own resolution — so it
 *    claims `.rs` specifiers before node-resolve tries to load raw Rust source
 *    as JavaScript. (Nitro merges user `rollupConfig.plugins` ahead of its
 *    own, so the top-level position works.)
 *
 * The plugin's other Vite-specific hooks (`config`, `configResolved`) are
 * silently ignored by Rollup. Skipping `configResolved` means the plugin's
 * root stays `process.cwd()` — correct when `nuxt build` / `nuxt dev` run from
 * this directory.
 */
import type { LoadResult, Plugin as RollupPlugin, PluginContext } from "rollup";
import { rustPlugin, type RustPluginOptions } from "vite-plugin-native-rust";

type LoadHook = (
  this: PluginContext,
  id: string,
  options?: { ssr?: boolean },
) => LoadResult | Promise<LoadResult>;

const MANGLED_FILE_URL_TOKEN =
  /globalThis\._importMeta_\.ROLLUP_FILE_URL_(\w+)/g;

export function rustPluginForNitro(options?: RustPluginOptions): RollupPlugin {
  const base = rustPlugin(options);
  const baseLoad = base.load as LoadHook;

  return {
    ...(base as unknown as RollupPlugin),
    name: "vite-rust:nitro",

    load(this: PluginContext, id: string) {
      // Nitro's Rollup pass is server-only by construction; see note 1 above.
      return baseLoad.call(this, id, { ssr: true });
    },

    renderChunk(this: PluginContext, code: string) {
      // Repair the file-URL tokens Nitro's import.meta shim mangled before
      // Rollup could resolve them; see note 2 above.
      if (!code.includes("ROLLUP_FILE_URL_")) return null;
      return {
        code: code.replace(MANGLED_FILE_URL_TOKEN, (_match, referenceId) => {
          const assetFileName = this.getFileName(referenceId as string);
          return `new URL(${JSON.stringify(assetFileName)}, globalThis._importMeta_.url)`;
        }),
        map: null,
      };
    },

    // Disable the plugin's post-write safety net inside the Nitro pass. It
    // assumes chunks resolve the addon relative to THEMSELVES (Vite/Rollup
    // semantics), but Nitro's runtime resolves `globalThis._importMeta_.url`
    // against the server ENTRY — so the net's chunk-sibling copies are never
    // read at runtime; they only add a spurious "recovered dropped addon"
    // warning and ~500 kB of dead weight per referencing chunk directory,
    // which the Vercel preset would ship inside the deployed function. The
    // one copy that IS read — the emitted asset at the output-server root —
    // is written directly by Rollup and cannot be dropped (Nitro does no
    // in-memory repackaging of the written bundle).
    writeBundle() {},
  };
}
