# Astro + vite-plugin-native-rust

A minimal [Astro](https://astro.build) app that imports a Rust crate directly
from server code:

```ts
// src/lib/rust.server.ts
import { add, sumTo } from "../../native/src/lib.rs";
```

Two on-demand-rendered routes call the compiled napi-rs addon on every request:

- `/` — an `.astro` page whose frontmatter calls `add(2, 3)` (= 5) and
  `await sumTo(1000)` (= 500500) and renders the results.
- `/api/rust.json` — an API endpoint returning the same values as JSON.

Deployed at **https://vpnr-example-astro.vercel.app** (Vercel Functions,
`nodejs24.x`).

## How the wiring works

- **`astro.config.mjs`** — `rustPlugin()` goes in `vite.plugins`. Astro forwards
  it into every Vite pass it runs (dev SSR, client build, server build).
  `output: "server"` + `adapter: vercel()` keeps every page on-demand rendered;
  the Rust call happens at request time, so the pages must not be prerendered
  (a prerendered page would bake the values into static HTML at build time —
  which would *work*, but demonstrates nothing).
- **`src/lib/rust.server.ts`** — the single import site for the `.rs` file.
  Astro has **no `.server.ts` filename convention** — the suffix here is
  documentation, not enforcement. What keeps the crate out of the browser is
  that the module is only imported from `.astro` frontmatter and API routes,
  which never ship to the client. The plugin's `options.ssr` gate is the
  backstop: importing the `.rs` from client-reachable code (e.g. a `<script>`
  tag or a hydrated island) fails the build with a readable error — verified,
  see [Caveats](#caveats).
- **`tsconfig.json`** — extends `astro/tsconfigs/strict` and adds
  `allowArbitraryExtensions: true` so TypeScript resolves the plugin-generated
  `native/src/lib.d.rs.ts` for the `.rs` import. `npm run typecheck` passes
  without a Rust toolchain because that file is committed.
- **`native/`** — a stock `npm create native-rust` crate (one sync `add`, one
  async `sumTo`), untouched.

## Run it locally

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust

cd examples/astro
npm run dev          # first request compiles the crate (~20-30s cold), then instant
curl localhost:4321/api/rust.json   # {"add":5,"sumTo":500500,...}

npm run build        # release build → .vercel/output/
npm run preview      # serves the ACTUAL Vercel function bundle on :4400
curl localhost:4400/api/rust.json
```

`npm run preview` is **not** `astro preview` — `@astrojs/vercel` doesn't
support it. Instead, `scripts/serve-vercel-output.mjs` imports the traced
function bundle from `.vercel/output/functions/_render.func/` (whose entry
default-exports `{ fetch }`, the shape Vercel's Node launcher invokes) and
serves it over plain `node:http`. That validates the exact artifact Vercel
deploys — including that the `.node` addon was traced into the function and
loads — rather than some other local approximation.

## How the addon travels to Vercel (what we verified)

Astro's server build emits the addon at the server-output root while the
importing chunk lands in `chunks/`, so the generated reference is
`new URL("../astrodemo-<hash>.node", import.meta.url)`. `@astrojs/vercel` then
runs `@vercel/nft` over the server entry; nft follows that `new URL` pattern
and places the addon at the same relative path inside the function:

```
.vercel/output/functions/_render.func/
  examples/astro/dist/server/astrodemo-<hash>.node   ← traced automatically
  examples/astro/dist/server/chunks/rust.server_<hash>.mjs   ← references ../astrodemo-<hash>.node
```

**No example-level copy step or adapter accommodation was needed** — the trace
holds on its own, same as the React Router example.

## Deploying

The Vercel project (`vpnr-example-astro`) has **Root Directory** =
`examples/astro` with **"Include files outside the Root Directory"** enabled,
so the whole workspace is present at build time and the example resolves the
workspace-local `vite-plugin-native-rust`. `vercel.json` routes install/build
through `scripts/vercel-install.sh` and `scripts/vercel-build.sh`, which
install a minimal stable Rust toolchain into `node_modules/.cache` (persisted
by Vercel's build cache) and build the plugin package before the example. See
[docs/deployment-vercel.md](../../docs/deployment-vercel.md) for the full
rationale; the scripts are the monorepo variant described there.

```bash
vercel deploy --prod --yes    # from the monorepo root
curl -s https://vpnr-example-astro.vercel.app/api/rust.json
# {"add":5,"sumTo":500500,"runtime":"v24.x.x"}
```

## Caveats

- **Cosmetic warning on every release build** (plugin issue, harmless here):
  Astro 7 runs on Vite 8 (rolldown), which emits the addon asset at the output
  root while the chunk lives in `chunks/`. The plugin's post-write guarantee
  (issue #1) assumes the addon must sit *beside* the referencing chunk, so it
  logs `[vite-rust] recovered dropped addon …` and copies a duplicate into
  `chunks/`. The root copy — the one the chunk actually references via `../` —
  was written by Rollup all along, so the "recovery" is a false positive: the
  build works with or without it. Cost: one spurious warning + a ~500 KB
  duplicate `.node` in the build output (the duplicate is *not* traced into
  the deployed function, so it never ships). Tracked as a plugin follow-up.
- **The dev-server first hit is slow.** The first request that touches the
  crate triggers `cargo build` (~20–30 s cold). Astro 7's dev server also
  detaches by default (`astro dev` returns; use `astro dev stop` / `astro dev
  logs`).
- **Client-side imports fail loudly (by design).** A `<script>` tag or hydrated
  island importing the `.rs` (directly or via `rust.server.ts`) dies at build
  time with the plugin's "Rust modules can only be imported server-side" error.
  Keep `.rs` imports in frontmatter, endpoints, middleware, or actions.
- **Prerendered pages would silently defeat the demo.** With `output: "static"`
  (Astro's default) the frontmatter runs at *build* time — the Rust calls
  still execute, but on the build machine, once. If you want request-time Rust,
  the importing route must be on-demand (`output: "server"` here, or
  `export const prerender = false` per page).
