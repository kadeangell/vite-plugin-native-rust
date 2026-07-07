# Nitro integration — `vite-plugin-native-rust/nitro`

Helpers for the Nitro family (Nuxt, SolidStart v1/vinxi, TanStack Start, raw
Nitro). Nitro **re-bundles the Vite server output with its own Rollup
pipeline**, which breaks the plugin's build shape in four documented ways;
this subpath packages the fixes that every Nitro consumer previously
hand-rolled (~40 lines per framework — see
[issue #3](https://github.com/kadeangell/vite-plugin-native-rust/issues/3)).

> **Nitro version note (read this first):** everything here was built and
> verified against **Nitro 2.x** (Nuxt 4, SolidStart v1/vinxi, TanStack
> Start's nitro plugin). **Nitro v3 (Nuxt 5) is a ground-up rewrite** — the
> `import.meta` shimming, the `compiled` hook, and the re-bundle behavior these
> helpers accommodate may all differ. Re-validate every accommodation on v3
> before relying on this module, and follow
> [issue #3](https://github.com/kadeangell/vite-plugin-native-rust/issues/3)
> for status.

## The four breakages

| # | What Nitro does | What breaks | Which helper fixes it |
|---|---|---|---|
| 1 | Its Rollup pass calls `load(id)` with **no `{ ssr }` options** (raw Rollup semantics) | The plugin's client gate rejects every `.rs` import as "client-side" | `nitroRustPlugin()` forces `ssr: true` — sound because Nitro's pass is server-only by construction |
| 2 | `@rollup/plugin-replace` rewrites `import.meta.` → `globalThis._importMeta_.` at **transform time**, and its esbuild step targets es2019 (where `import.meta` is stubbed to `{}`) | The plugin's `import.meta.ROLLUP_FILE_URL_<ref>` token is destroyed **before Rollup can resolve it** → the chunk ships a dead token and crashes on first request | `nitroRustPlugin()`'s `renderChunk` repairs each mangled token to `new URL("<asset>", globalThis._importMeta_.url)` — *or*, for the Vite-pass integration style, `nitroPreserveImportMeta()` keeps `import.meta.url` real so no repair is needed |
| 3 | The re-bundle treats upstream Vite output as **plain JS input** — assets Vite emitted (the compiled `.node`) are not assets to Nitro's Rollup and never reach the final output | The addon is silently dropped; the server cold-start-crashes | `nitroShipAddons()` copies the addon into Nitro's output on the `compiled` hook |
| 4 | Nitro's runtime resolves `globalThis._importMeta_.url` against the server **entry**, not the chunk | The base plugin's `writeBundle` chunk-sibling recovery inverts into dead weight: its copies are never read, but add spurious "recovered dropped addon" warnings and ~500 kB per referencing chunk directory inside the deployed function | `nitroRustPlugin()` neutralizes the hook |

## Which helpers do I need?

Two distinct integration styles, depending on **where the rust plugin runs**:

### Style A — the plugin runs inside Nitro's own Rollup pass

Nuxt's `server/` directory (API routes, middleware) and raw Nitro apps.
The `.rs` import is compiled by Nitro's pipeline itself.

```ts
// nuxt.config.ts (or nitro.config.ts)
import { nitroRustPlugin } from "vite-plugin-native-rust/nitro";

export default defineNuxtConfig({
  nitro: {
    rollupConfig: {
      // MUST be first: `enforce: "pre"` is a Vite concept — raw Rollup runs
      // plugins in array order, and this plugin has to claim `.rs` specifiers
      // before node-resolve tries to parse Rust source as JavaScript. (Nitro
      // merges user rollupConfig.plugins ahead of its own, so the top-level
      // position works.)
      plugins: [nitroRustPlugin()],
    },
  },
});
```

`nitroRustPlugin(options?)` accepts the same options as `rustPlugin()` and
applies accommodations **1, 2, and 4**. Rollup writes the emitted `.node` at
the output root — the entry's own directory — so the repaired entry-relative
reference resolves with no copy step needed for this style.

### Style B — the plugin runs in the framework's Vite passes, Nitro re-bundles the result

SolidStart v1 (vinxi), and Nuxt's **app layer** (a `.server.ts` plugin
importing `.rs`). The Vite output already contains the *resolved* loader; the
problems are Nitro mangling `import.meta.url` (style B1) and dropping the
addon (both).

**B1 — SolidStart v1 / vinxi** (the chunks Nitro consumes reference the addon
*chunk-relative*):

```ts
// app.config.ts
import { nitroPreserveImportMeta, nitroShipAddons } from "vite-plugin-native-rust/nitro";

export default defineConfig({
  vite: { plugins: [rustPlugin()] },
  server: {
    // Keeps `import.meta.url` REAL through the re-bundle: an identity
    // `replace` entry (longest-key-first exempts exactly `import.meta.url`
    // from the `globalThis._importMeta_.` stub) + esbuild target es2022
    // (es2019, Nitro's default, stubs `import.meta` to `{}`).
    ...nitroPreserveImportMeta(),
    // Nitro inlines the loader into chunks/nitro/nitro.mjs; the preserved
    // chunk-relative `../<name>.node` resolves to <serverDir>/chunks/.
    modules: [
      nitroShipAddons({ from: ".vinxi/build/ssr", to: "chunks", required: true }),
    ],
  },
});
```

**B2 — Nuxt app layer** (Nitro's re-bundle leaves the reference
*entry-relative* — `new URL("<name>.node", globalThis._importMeta_.url)` —
so the copy goes to the server root):

```ts
// nuxt.config.ts
nitro: {
  modules: [nitroShipAddons({ from: ".nuxt/dist/server" })],
}
```

### TanStack Start needs none of this

Its Nitro plugin's re-bundle preserves the resolved chunk-relative loader and
the base plugin's built-in `writeBundle` recovery re-places the dropped addon
at exactly the referenced path — no config-side accommodation at all. See
[examples/tanstack-start](../examples/tanstack-start).

## API

### `nitroRustPlugin(options?: RustPluginOptions): Plugin`

`rustPlugin()` adapted for Nitro's raw Rollup pass (accommodations 1, 2, 4).
Place it **first** in `nitro.rollupConfig.plugins`. The base plugin's
Vite-only hooks (`config`, `configResolved`) are silently ignored by Rollup,
so the plugin root stays `process.cwd()` — correct when the framework build
runs from the project directory.

### `nitroShipAddons(options): NitroModuleLike`

A **Nitro module** that copies compiled `.node` addons into Nitro's output on
the `compiled` hook (accommodation 3).

- `from: string | string[]` — directory/ies to scan for `.node` files (the
  upstream Vite pass's server output). Relative paths resolve against
  `process.cwd()`; missing directories are skipped silently.
- `to?: string` — destination subdirectory inside
  `nitro.options.output.serverDir`. Default `""` (the server root — where
  entry-relative references resolve). Use `"chunks"` for the
  chunk-relative/vinxi style.
- `required?: boolean` — fail the **build** when no addon is discovered
  (default `false`). Turn it on when the addon is load-bearing; a build-time
  failure beats a deploy that cold-start-crashes.

Copies are idempotent (addon file names are content-hashed, so same name ⇒
same binary; existing destinations are skipped).

**Register it in `modules`, never as a `hooks.compiled` config entry** — a
user-level `hooks.compiled` *replaces* a preset's own compiled hook (the
Vercel preset writes its Build Output API metadata there), silently breaking
the deploy. A module adds its hook via `nitro.hooks.hook()` additively.

### `nitroPreserveImportMeta(): { replace, esbuild }`

Config fragment to spread into the Nitro/server config for the Vite-pass
integration style (accommodation 2, the no-repair variant). Scope note: it
keeps `import.meta.url` real for the **whole** server bundle, not just the
loader chunk — for a pure-ESM Node function the real value is more correct
than Nitro's entry-URL stub, but if other code depends on the stubbed
behavior, re-test.

### `repairMangledFileUrlTokens(code, getAssetFileName)`

The pure token-repair function `nitroRustPlugin()` uses in `renderChunk`,
exported for testing and for anyone composing their own adapter. Only the
*damaged* form (`globalThis._importMeta_.ROLLUP_FILE_URL_<ref>`) is rewritten;
an intact `import.meta.ROLLUP_FILE_URL_<ref>` is left for Rollup to resolve
natively.

## Verified examples

- [examples/nuxt](../examples/nuxt) — both pipelines: `nitroRustPlugin()` for
  `server/`, `nitroShipAddons()` for the app layer.
- [examples/solidstart](../examples/solidstart) —
  `nitroPreserveImportMeta()` + `nitroShipAddons({ to: "chunks" })`.
- [examples/tanstack-start](../examples/tanstack-start) — no helper needed
  (plugin-internal recovery).
