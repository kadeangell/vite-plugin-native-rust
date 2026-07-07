# Nuxt + vite-plugin-native-rust

A minimal [Nuxt 4](https://nuxt.com) app that imports a Rust crate directly
from server code — in **both** of Nuxt's build pipelines:

```ts
// app/plugins/rust.server.ts  (app layer — built by Vite)
import { add, sumTo } from "../../native/src/lib.rs";

// server/api/rust.ts          (server/ dir — built by Nitro's own Rollup)
import { add, sumTo } from "../../native/src/lib.rs";
```

- `/` — the page renders values computed during SSR by a `.server.ts` Nuxt
  plugin (`add(2, 3)` = 5, `await sumTo(1000)` = 500500), plus the same values
  fetched from the API route.
- `/api/rust` — a Nitro API route returning the values as JSON.

Deployed at **https://vpnr-example-nuxt.vercel.app** (Vercel Functions,
`nodejs24.x`).

## The interesting part: Nuxt is TWO build pipelines

Nuxt splits its build. **Vite** handles the app layer — pages, components,
plugins, and their SSR bundle. The **`server/` directory** (API routes,
middleware) is bundled by **Nitro with its own Rollup pass** that never sees
your Vite plugins. The Rust plugin has to be registered in each pipeline it
should serve, and the two registrations are different:

```ts
// nuxt.config.ts
import { rustPlugin } from "vite-plugin-native-rust";
import { nitroRustPlugin, nitroShipAddons } from "vite-plugin-native-rust/nitro";

vite: { plugins: [rustPlugin()] },                          // app layer
nitro: {
  rollupConfig: { plugins: [nitroRustPlugin()] },           // server/ dir
  modules: [nitroShipAddons({ from: ".nuxt/dist/server" })], // app-layer addon → .output
}
```

Both Nitro-side pieces come from the plugin's **`/nitro` subpath** — the
packaged version of the hand-rolled adapter this example originally carried
(see the plugin's [docs/nitro.md](../../docs/nitro.md) for every
accommodation and why it exists).

### Vite layer (app code) — works, with one placement hook

`rustPlugin()` in `vite.plugins` is forwarded into the client build, the SSR
build, and the dev server. The app-layer server-only convention here is a
**`.server.ts` Nuxt plugin** (`app/plugins/rust.server.ts`): it runs during
SSR only and the client's plugin manifest never imports it, so the `.rs`
import cannot reach the browser. The results are stashed in `useState`, which
Nuxt serializes into the payload for hydration.

The plugin's `options.ssr` gate behaves correctly across Nuxt's client/server
Vite passes — importing the `.rs` from client-reachable code (e.g. directly in
a page's `<script setup>`) fails the client build with the plugin's readable
"Rust modules can only be imported server-side" error (verified).

One wrinkle: `nuxt build` runs the Vite SSR build first, then **Nitro
re-bundles Vite's server output** into `.output/server/chunks/`. Nitro's
Rollup pass knows nothing about the `.node` asset Vite emitted, so it would be
left behind. The `nitroShipAddons({ from: ".nuxt/dist/server" })` Nitro module
copies any app-layer `.node` from the Vite server output into
`.output/server/` on Nitro's `compiled` hook — that's the whole fix, because
Nitro's runtime resolves the surviving
`new URL("<name>.node", globalThis._importMeta_.url)` reference against the
server *entry*, i.e. the output root.

### Nitro layer (server/ dir) — works, via `nitroRustPlugin()`

`rustPlugin()` is hook-compatible with plain Rollup, but two Vite/Nitro-isms
bite; `nitroRustPlugin()` (from `vite-plugin-native-rust/nitro`) adapts both:

1. **Raw Rollup passes no `{ ssr }` to `load`**, so the plugin's server-only
   gate would reject every import as "client-side". Nitro's pass is
   server-only by construction, so the adapter forces `ssr: true` —
   preserving the gate's intent exactly.
2. **Nitro's `import.meta` shim mangles Rollup file-URL tokens.** Nitro
   registers `@rollup/plugin-replace` mapping `import.meta.` →
   `globalThis._importMeta_.` at *transform* time, which rewrites the
   plugin's `import.meta.ROLLUP_FILE_URL_<ref>` before Rollup can resolve it —
   the chunk would ship a literal dead token and crash on first request. The
   adapter's `renderChunk` repairs each mangled token into
   `new URL("<asset>", globalThis._importMeta_.url)`, which resolves
   entry-relative at runtime — matching where Rollup writes the emitted asset.

The helper must be **first** in `nitro.rollupConfig.plugins` (Nitro merges
user plugins ahead of its own) so it claims `.rs` specifiers before
node-resolve tries to parse Rust source as JavaScript. `enforce: "pre"` is a
Vite concept and does nothing under raw Rollup.

In `nuxt dev`, Nitro builds the dev server with Rollup in watch mode, so the
plugin takes its dev shape (require from the absolute cache path) — both
layers work in dev with no extra wiring.

## Run it locally

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust

cd examples/nuxt
npm run dev          # first request compiles the crate (~20-30s cold), then instant
curl localhost:3000/api/rust    # {"add":5,"sumTo":500500,...}

npm run build        # release build → .output/ (node-server preset)
npm run preview      # node .output/server/index.mjs
curl localhost:3000/api/rust

npm run typecheck    # vue-tsc over Nuxt's project references; passes without
                     # a Rust toolchain because native/src/lib.d.rs.ts is committed
```

Requires a Rust toolchain (`cargo` on `PATH`) to build; the crate in `native/`
was scaffolded with `npm create native-rust`.

To validate the exact Vercel artifact locally:

```bash
NITRO_PRESET=vercel npm run build   # → .vercel/output/
# the function entry default-exports a Node handler; serve it directly:
node -e "import('./.vercel/output/functions/__fallback.func/index.mjs')
  .then(m => require('node:http').createServer(m.default).listen(3112))"
curl localhost:3112/api/rust
```

## TypeScript

`allowArbitraryExtensions` (which lets TS resolve the generated
`native/src/lib.d.rs.ts` for the `.rs` import) must reach **both** of Nuxt's
generated tsconfig projects, and each has its own knob in `nuxt.config.ts`:

- `typescript.tsConfig` → `.nuxt/tsconfig.app.json` (app layer)
- `nitro.typescript.tsConfig` → `.nuxt/tsconfig.server.json` (server/ dir)

Verified real: breaking a call signature (`add("two", 3)`) fails
`npm run typecheck` with TS2345.

## Vercel deploy

On Vercel, Nitro auto-detects the `vercel` preset and writes the Build Output
API directory at `.vercel/output`. Every route is a symlink to the single
`__fallback.func`, and the addon sits at that function's root — exactly where
the entry-relative runtime reference resolves. No `@vercel/nft` tracing is
involved (unlike the SvelteKit/Astro examples): Nitro packages the function
itself, and the addon travels as a Rollup-emitted asset. The
`nitro.vercel.functions.runtime` pin (`nodejs24.x`) keeps the function runtime
off Nitro's local-Node-keyed default.

Project `vpnr-example-nuxt`, Root Directory `examples/nuxt` with "Include
source files outside of the Root Directory" enabled (the example lives in an
npm workspace and resolves `vite-plugin-native-rust` from the monorepo).
`vercel.json` routes install/build through `scripts/vercel-install.sh` and
`scripts/vercel-build.sh`, which install a minimal stable Rust toolchain into
`node_modules/.cache` (persisted by Vercel's build cache) and build the plugin
package before the example — the monorepo variant described in
[docs/deployment-vercel.md](../../docs/deployment-vercel.md).

```bash
# from the repo root, after `vercel link --yes --project vpnr-example-nuxt`
vercel deploy --prod --yes
curl -s https://vpnr-example-nuxt.vercel.app/api/rust
# {"add":5,"sumTo":500500,"runtime":"v24.x.x","where":"nitro server/api route"}
```

## Caveats

- **Commit `native/Cargo.lock` or cold builds compile twice** (once per
  pipeline). The lockfile is part of the plugin's content-hash cache key; when
  it doesn't exist yet, the first pipeline's compile *creates* it, so the
  second pipeline computes a different hash and misses the cache (~24 s wasted
  on a Vercel cold build — observed before the lockfile was committed). With
  the lockfile present (it's committed here), a cold build compiles exactly
  once and both pipelines share the cached binary; warm builds skip cargo
  entirely.
- **`nitroRustPlugin()` disables the plugin's post-write safety net**
  (`writeBundle`) inside the Nitro pass: the net assumes chunk-sibling addon
  resolution, but Nitro resolves entry-relative, so its recovered copies are
  never read — they only added spurious warnings and ~500 kB of dead weight
  per referencing chunk directory *inside the deployed function*. See the
  plugin's [docs/nitro.md](../../docs/nitro.md) for the full reasoning.
- **Don't call Rust from prerendered pages.** This example keeps every route
  on-demand (Nuxt's default). A prerendered/`routeRules` static page would run
  the Rust at build time and bake the values in — it would "work" but
  demonstrate nothing, and `nitro.prerender` runs in yet another context.
- **The first dev request pauses** while cargo cold-builds the crate
  (~20–30 s; watch for `[vite-rust] compiling crate…`). Later requests hit the
  content-hash cache.
