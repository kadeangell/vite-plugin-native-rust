# vite-plugin-native-rust

> **Experimental — 0.3.** Still pre-1.0; the API may shift between minor releases, with any change called out in the [changelog](CHANGELOG.md). See the [supported matrix](#supported).

Import Rust directly in Vite SSR server code. Write

```ts
// reports.server.ts
import { hashChain } from "./native/src/lib.rs";
```

and the plugin compiles the enclosing [napi-rs](https://napi.rs) crate into a
native `.node` addon for the current platform, content-hash caches it, generates
named-export JavaScript that loads the binary at runtime, and mirrors napi's
generated `.d.ts` next to your `.rs` file so TypeScript resolves the exports. The
work runs on real threads **off the Node event loop**, and the compiled addon
travels with your `vite build` output — including onto serverless platforms like
Vercel, where the plugin needs zero code changes.

Rust modules are **server-only** by design: importing a `.rs` file from code that
can reach the client bundle is a build error.

## Why

Heavy CPU-bound work in a server loader — hashing, parsing, compression,
numeric crunching — either blocks Node's single event loop (starving every other
request) or gets shipped to a worker thread that still runs at JavaScript speed.
Moving the hot path into an `#[napi] async fn` runs it on native threads that
never touch the event loop. The measurements below are the whole argument.

## Measurements

Same 6,000,000-iteration SHA-256 hash chain in synchronous JS vs. an
`#[napi] async fn`, rendering an identical digest either way (a true A/B). Full
methodology and raw numbers in [docs/benchmarks.md](docs/benchmarks.md).

**Local** (Apple M5, 10 cores, Node 25.8.1, release build):

| | JS | Rust | Rust win |
| --- | --- | --- | --- |
| Single request | 2255.9 ms | 782.0 ms | **~2.9× faster** |
| 5 concurrent (wall) | 11486 ms | 1076 ms | **~10.7× faster** |
| A 1 ms endpoint during that load | 12393 ms (starved) | 1–2 ms | **stays responsive** |

Locally the biggest win is **availability**: a synchronous JS loader jams the
one event loop and starves all other traffic; the Rust version costs one busy
thread.

**Vercel** (Fluid compute, `nodejs24.x`, `iad1`):

| | JS | Rust | Rust win |
| --- | --- | --- | --- |
| Single request | 18302 ms | 2614 ms | **~7.0× faster** |
| Active-CPU billing (∝ wall) | — | — | **~7× cheaper** |

On serverless the story **changes honestly**: Fluid fans concurrent requests out
to separate instances, so a blocking JS request never starves an unrelated one —
the availability advantage is **neutralized by the platform**. What remains, and
matters more on serverless, is **~7× lower latency and ~7× lower active-CPU
cost** for the same computation. See
[docs/benchmarks.md](docs/benchmarks.md#vercel-serverless) for the fan-out
correction told straight.

## Supported

| | |
| --- | --- |
| Vite | >= 6 (peer dependency; Vite 8 / rolldown validated) |
| Frameworks | React Router v7 / v8, vanilla Vite SSR, SvelteKit, Astro, TanStack Start, Qwik City — out of the box. Nuxt + SolidStart — via the `vite-plugin-native-rust/nitro` helpers (see [docs/nitro.md](docs/nitro.md)). |
| OS | macOS, Linux |
| Node | >= 20 |
| Build-time | Rust toolchain (`cargo` on `PATH`) + `@napi-rs/cli` >= 3 |

**Windows support is not planned.** Deno, Bun, and edge runtimes are out of scope —
see [docs/when-not-to-use.md](docs/when-not-to-use.md). Next.js and Remix v3
don't run Vite, so the plugin can't apply there — but the same napi-rs crate
works directly; see [examples/nextjs](examples/nextjs) and
[examples/remix-v3](examples/remix-v3) for the plugin-free pattern.

## Quickstart

**1. Scaffold a crate** (optional, but the fastest start):

```bash
npm create native-rust native
```

This writes a ready-to-build napi-rs crate in `./native/` with one sync and one
async sample export, then prints the wiring steps below.

**2. Install the plugin and the napi CLI it drives:**

```bash
npm i -D vite-plugin-native-rust @napi-rs/cli
```

**3. Add the plugin to your Vite config, before your framework plugin:**

```ts
// vite.config.ts
import { rustPlugin } from "vite-plugin-native-rust";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rustPlugin(), /* ...your other plugins */],
});
```

**4. Let TypeScript resolve the generated `.d.rs.ts` types** by enabling this in
your `tsconfig.json` `compilerOptions`:

```jsonc
"allowArbitraryExtensions": true
```

(The plugin also adds this for you if your root `tsconfig.json` is plain JSON.)

**5. Import the crate from server-only code** — a `.server.ts` module, so the
`.rs` import never leaks into the client bundle:

```ts
// something.server.ts
import { add, sumTo } from "./native/src/lib.rs";

const five = add(2, 3);            // sync, on the main thread
const total = await sumTo(1_000);  // async, off the event loop
```

The **first** dev-server request that touches the crate triggers a cargo build
(~30s cold, cached after that), so that initial response pauses while Rust
compiles. Every later request hits the cached native addon.

## Options

`rustPlugin(options?)` — every option is optional; the defaults reproduce the
zero-argument behavior.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cacheDir` | `string` | `node_modules/.cache/vite-rust` | Where compiled `.node` addons and versioned `.d.ts` are cached. Relative paths resolve against the Vite root. |
| `profile` | `'debug' \| 'release'` | auto | Force a build profile. Auto = `debug` in dev/watch, `release` in `vite build`. |
| `napiArgs` | `string[]` | `[]` | Extra arguments appended to the `napi build` invocation. |
| `generateCratePackageJson` | `boolean` | `true` | Write a `package.json` carrying `napi.binaryName` when the crate lacks one. `false` errors instead of mutating your crate. |
| `emitTypes` | `boolean` | `true` | Mirror napi's generated types to a `.d.rs.ts` beside the imported `.rs`. `false` skips all `.d.rs.ts` writes. |
| `logLevel` | `'silent' \| 'info'` | `'info'` | `'silent'` suppresses the compile-progress and type-write lines; warnings and errors always show. |
| `prewarm` | `boolean \| string[]` | `true` | Pre-compile known crates at dev-server startup (remembered via a manifest in `cacheDir`; an array adds explicit anchors; `false` disables). A request arriving mid-pre-warm joins the in-flight compile. |

The cache key folds in the crate's full local dependency closure — path deps,
workspace members, the workspace `Cargo.toml`, and the lockfile — plus the
`rustc` and `@napi-rs/cli` versions, so a change anywhere in that set recompiles
instead of serving a stale binary.

## Documentation

| Doc | What it covers |
| --- | --- |
| [how-it-works.md](docs/how-it-works.md) | The resolve → load → compile → cache → emit pipeline, and why it survives bundling and serverless tracing. |
| [nitro.md](docs/nitro.md) | The Nitro-family helpers (Nuxt `server/`, SolidStart, raw Nitro): what Nitro breaks and how each accommodation works. |
| [rust-patterns.md](docs/rust-patterns.md) | Copyable napi patterns from the showcase: async-vs-sync, Buffers + options structs, stateful libs, Result errors, and why debug builds lie about perf. |
| [typescript.md](docs/typescript.md) | `allowArbitraryExtensions`, the generated `.d.rs.ts`, committing types for CI, and proof the types are real. |
| [testing.md](docs/testing.md) | The vitest story: `rustPlugin()` in the vitest config, the `rustTestStub` JS-twin helper, and the `test.projects` setup. |
| [deployment-vercel.md](docs/deployment-vercel.md) | `vercelPreset`, the install/build scripts, the toolchain reality, cache strategy, and monorepo notes. |
| [benchmarks.md](docs/benchmarks.md) | Both measurement sets in full, methodology, and the serverless fan-out correction. |
| [troubleshooting.md](docs/troubleshooting.md) | Every real failure mode and its fix. |
| [when-not-to-use.md](docs/when-not-to-use.md) | The honest cases where this plugin buys you nothing. |

## Packages

- **[`vite-plugin-native-rust`](packages/vite-plugin-native-rust)** — the Vite plugin.
- **[`create-native-rust`](packages/create-native-rust)** — the `npm create native-rust` scaffolding CLI.
- **[`examples/showcase`](examples/showcase)** — real crates.io integrations with live JS-baseline A/Bs: [tantivy](https://crates.io/crates/tantivy) full-text search (sub-ms BM25 queries vs minisearch), an image pipeline (SIMD resize + WebP/AVIF — ~9× jimp, in formats JS can't encode), a streaming [lol_html](https://crates.io/crates/lol_html) + ammonia email-HTML transformer (~5× cheerio), and argon2 hashing with a measured event-loop-starvation experiment. Live at vpnr-showcase.vercel.app with a [/benchmarks](https://vpnr-showcase.vercel.app/benchmarks) page that runs every A/B per request.
- **[`examples/react-router`](examples/react-router)** — React Router v7 app with the Rust A/B routes and Vercel wiring.
- **[`examples/sveltekit`](examples/sveltekit)** — SvelteKit + adapter-vercel; plugin works out of the box (Vite 8 / rolldown).
- **[`examples/astro`](examples/astro)** — Astro SSR + @astrojs/vercel; plugin works out of the box.
- **[`examples/tanstack-start`](examples/tanstack-start)** — TanStack Start; works with zero config (the plugin's addon-recovery pass handles Nitro's re-bundle).
- **[`examples/qwik`](examples/qwik)** — Qwik City; plugin works out of the box, deployed via the Node middleware (Qwik's official Vercel adapter is edge-only, where native addons can't run).
- **[`examples/nuxt`](examples/nuxt)** — Nuxt, Rust in **both** pipelines: Vite app layer out of the box, Nitro `server/` routes via a small documented adapter.
- **[`examples/solidstart`](examples/solidstart)** — SolidStart (v1/vinxi); works with a three-part Nitro recipe in `app.config.ts`, all documented.
- **[`examples/nextjs`](examples/nextjs)** — Next.js has no Vite: the same crate consumed directly, with the Turbopack + file-tracing workarounds documented.
- **[`examples/remix-v3`](examples/remix-v3)** — Remix v3 (beta) has no Vite or build step: direct crate consumption + the serverless bundling recipe.

All nine examples deploy to Vercel and are validated against live production URLs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the test commands, and PR
expectations. Security reports go through
[private advisories](SECURITY.md).

## License

MIT © Kade Angell
