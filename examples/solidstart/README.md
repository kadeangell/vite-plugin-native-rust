# SolidStart + vite-plugin-native-rust

A minimal [SolidStart](https://start.solidjs.com) (v1, vinxi-based) app that
imports a Rust crate directly from server code:

```ts
// src/lib/rust.ts
"use server";
import { add, sumTo } from "../../native/src/lib.rs";
```

Three server surfaces call the compiled napi-rs addon:

- `/` — SSR page whose `query` + `createAsync` render `add(2, 3)` (= 5) and
  `await sumTo(1000)` (= 500500) at request time.
- `/api/rust` — API route returning the same values as JSON.
- The "Run again from the browser" button — a client-initiated server-function
  RPC (`POST /_server`), which runs the Rust through vinxi's *third* build
  pass (server-fns).

Deployed at **https://vpnr-example-solidstart.vercel.app** (Vercel Functions,
`nodejs24.x`).

> **SolidStart v1 vs v2.** This example targets `@solidjs/start` 1.x — the
> npm `latest` line, built on vinxi (Vite + Nitro). `npm create solid` now
> also offers a v2 "(pre-release, recommended)" template built on plain Vite
> (`@solidjs/start` 2.0.0-alpha); the Nitro workarounds documented below are
> specific to the v1/vinxi pipeline and will need re-evaluation on v2 when it
> stabilizes.

## Run it

```bash
# from the monorepo root
npm install
npm run build -w vite-plugin-native-rust   # build the plugin dist the example consumes

cd examples/solidstart
npm run dev        # first request compiles the crate (~20-30s cold), then instant
curl localhost:3000/api/rust   # {"add":5,"sumTo":500500,...}

npm run build      # release build → .vercel/output/ (Build Output API)
npm run preview    # serves the ACTUAL Vercel function bundle on :4500
curl localhost:4500/api/rust
```

Requires a Rust toolchain (`cargo` on `PATH`); the crate in `native/` was
scaffolded with `npm create native-rust`. `npm run preview` is not
`vinxi start` — with the Vercel preset there is no local production server, so
`scripts/serve-vercel-output.mjs` imports the traced function bundle from
`.vercel/output/functions/__fallback.func/` (whose entry default-exports a
Node `(req, res)` listener) and serves it over plain `node:http`. That
validates the exact artifact Vercel deploys — including that the `.node`
addon shipped inside the function and loads.

## The three Vite passes (what worked, what didn't)

vinxi builds the app as three Vite "routers", then hands the server output to
**Nitro** for packaging. `rustPlugin()` goes in the `vite` option of
`app.config.ts`, which applies it to every pass:

| Pass | `.rs` import | Verdict |
| --- | --- | --- |
| `ssr` | reached via page `query` + API route | ✅ works out of the box — addon emitted beside the chunks in `.vinxi/build/ssr/` |
| `server-fns` | reached via the `"use server"` module | ✅ works out of the box — addon emitted in `.vinxi/build/server-fns/_server/` |
| `client` | replaced by RPC stubs | ✅ never sees the `.rs` (zero addon bytes/references in the client output) |
| **Nitro re-bundle** | consumes the ssr/server-fns output | ❌ **breaks the addon without two config workarounds** (below) |

- **The server gate fails loudly, as designed.** Importing the `.rs` from
  client-reachable code (we temporarily added
  `import { add } from "../../native/src/lib.rs"` to `src/routes/index.tsx`)
  kills the client-router build with:

  > [vite-rust] ... Rust modules can only be imported server-side — import
  > this only from a .server.ts module (or another server-only module), never
  > from code that can reach the client bundle.

  In SolidStart terms: keep the `.rs` import inside a module-level
  `"use server"` file (or anything only reachable from API routes /
  server functions) and the client pass only ever sees RPC stubs.

## The Nitro problem, and the two workarounds

vinxi's ssr pass ends with exactly what the plugin promises: a server chunk
referencing `new URL("../soliddemo-<hash>.node", import.meta.url)` with the
addon sitting at the right relative spot. Then Nitro **re-bundles those built
chunks with its own rollup pass** into
`.vercel/output/functions/__fallback.func/chunks/nitro/nitro.mjs`, and two
things break — neither of which SvelteKit/Astro/React Router hit, because
their adapters `@vercel/nft`-trace the Vite output instead of re-bundling it:

1. **Nitro rewrites `import.meta.url`.** Its rollup pass replaces every
   `import.meta.<x>` with `globalThis._importMeta_.<x>`, whose `url` is the
   *function entry* (`index.mjs` at the function root) — so the loader's
   `../soliddemo-<hash>.node` would resolve to *outside the function
   directory*. On top of that, Nitro's esbuild step targets `es2019`, where
   `import.meta` "is not available", so esbuild stubs it to `{}` — the loader
   would throw `Invalid URL` at cold start.
2. **Nitro drops the addon.** It treats the built ssr output as plain JS
   input; the `.node` asset Vite emitted is not an asset to Nitro's rollup,
   so nothing copies it into `.vercel/output`.

Both are fixed at **config level** in `app.config.ts` — no plugin changes, no
post-build script:

```ts
server: {
  // 1a. Nitro merges user `replace` entries last and
  //     @rollup/plugin-replace matches longest-key-first, so this identity
  //     mapping exempts exactly `import.meta.url` from the stub rewrite.
  replace: { "import.meta.url": "import.meta.url" },
  // 1b. es2022 keeps `import.meta` intact through Nitro's esbuild step
  //     (the function runs on Node 24; es2019 is Nitro's default).
  esbuild: { options: { target: "es2022" } },
  // 2.  After Nitro compiles, copy the addon from the ssr pass output into
  //     the function bundle. With a real `import.meta.url` the loader in
  //     chunks/nitro/nitro.mjs resolves `../<name>.node` → chunks/<name>.node.
  hooks: {
    compiled: async (nitro) => { /* copy .vinxi/build/ssr/*.node → chunks/ */ },
  },
},
```

With those two in place, the deployed function loads the addon and all three
routes return the Rust values — verified on the live deployment and against
the local `npm run preview` of the same artifact.

**Honest fragility note:** the copy destination works because the loader
string `../<name>.node` was authored for a chunk one directory below the
addon (`assets/` → root) and Nitro *happens* to also place the inlined loader
one directory below `chunks/` (`chunks/nitro/nitro.mjs`). If Nitro's chunking
ever inlines the loader at a different depth, the 0.2.1 lazy loader fails
with a readable error naming the exact path it expected — check that path and
move the copy destination to match.

## How the wiring works

- **`app.config.ts`** — `rustPlugin()` in `vite.plugins` (applied to all three
  router passes), `server.preset = "vercel"`, the runtime pin
  (`vercel.functions.runtime = "nodejs24.x"` — Nitro otherwise derives it
  from the *local* Node major, which may be a version Vercel rejects), and
  the two Nitro workarounds above.
- **`src/lib/rust.ts`** — the single import site for the `.rs` file, with a
  **module-level `"use server"`** directive. That is the load-bearing choice:
  the client pass replaces the whole module with RPC stubs and never follows
  its imports. (A *function-level* `"use server"` in a module that top-level
  imports the `.rs` would let the client pass reach the import and fail the
  build — correctly, but inconveniently.)
- **`src/routes/index.tsx`** — `query` + `createAsync` (SSR data), plus a
  button that calls the server function from the browser to exercise the RPC
  path.
- **`src/routes/api/rust.ts`** — plain API route (`GET`).
- **`tsconfig.json`** — `allowArbitraryExtensions: true` so TypeScript
  resolves the committed, plugin-generated `native/src/lib.d.rs.ts`;
  `skipLibCheck: true` because vinxi 0.5 / @solidjs/start 1.3 ship declaration
  files that do not typecheck on their own. `npm run typecheck` passes without
  a Rust toolchain.
- **`native/`** — a stock `npm create native-rust` crate (one sync `add`, one
  async `sumTo`), untouched.

## Caveats

- **The first dev request is slow.** The first request that touches the crate
  runs a cold `cargo` debug build (~20-30 s; watch for the
  `[vite-rust] compiling crate "soliddemo"` line). Later requests hit the
  content-hash cache.
- **The workarounds poke at Nitro internals.** `replace` and
  `esbuild.options.target` are public Nitro config, but the *reason* they are
  needed (the `_importMeta_` rewrite) is an implementation detail that could
  change across Nitro majors. Re-verify with `npm run preview` after
  upgrading `vinxi`/`@solidjs/start`.
- **Keeping `import.meta.url` real is safe here but global.** It applies to
  the whole server bundle, not just the loader chunk. For a pure-ESM Node
  function the real value is *more* correct than Nitro's entry-URL stub, and
  the full route matrix was validated against the built artifact — but if you
  add code that depends on the stubbed behavior, re-test.
- **Server-function IDs embed absolute build-machine paths** (e.g.
  `/vercel/path0/...` in `X-Server-Id`). That is SolidStart's directives
  plugin, unrelated to the Rust plugin — cosmetic, but visible in the client
  bundle.
- **Prerendering would defeat the demo.** These routes are SSR'd on demand
  (SolidStart's default). A prerendered page would bake 5/500500 into static
  HTML at build time — it would *work*, but demonstrate nothing.

## Vercel deploy

Live at **https://vpnr-example-solidstart.vercel.app** — the page returns the
Rust values (5 / 500500) from a `nodejs24.x` function.

Project `vpnr-example-solidstart`, Root Directory `examples/solidstart` with
"Include source files outside of the Root Directory" enabled (the example
lives in an npm workspace and resolves `vite-plugin-native-rust` from the
monorepo).

- **`vercel.json`** points install/build at `scripts/vercel-install.sh` and
  `scripts/vercel-build.sh` (Vercel rejects inline commands > 256 chars).
- **`scripts/vercel-install.sh`** — `npm install` at the repo root, then
  installs a minimal stable Rust toolchain into `node_modules/.cache/{cargo,rustup}`
  (the Vercel build image ships rustup but no default toolchain; the cache dir
  rides Vercel's build cache so warm builds skip the download).
- **`scripts/vercel-build.sh`** — re-exports the cargo PATH (install/build run
  in separate shells), builds the plugin dist, then this example. Nitro's
  vercel preset writes the Build Output API directory at `.vercel/output`,
  which Vercel deploys as-is.

```bash
# from the repo root, after `vercel link --yes --project vpnr-example-solidstart`
vercel deploy --prod --yes
curl -s https://vpnr-example-solidstart.vercel.app/api/rust
# {"add":5,"sumTo":500500,"runtime":"node v24.x.x"}
```
