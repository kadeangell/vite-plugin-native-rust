# vite-plugin-native-rust

> **Experimental — 0.2.** Still pre-1.0; the API may shift between minor
> releases, with any change called out in the
> [changelog](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/CHANGELOG.md).

Import Rust directly in Vite SSR server code:

```ts
// something.server.ts — server-only (never reachable from the client bundle)
import { hashChain } from "./native/src/lib.rs";

export const digest = await hashChain(6_000_000);
```

The plugin compiles the enclosing [napi-rs](https://napi.rs) crate into a native
`.node` addon for the current platform, content-hash caches it, generates
named-export JS that loads the binary at runtime, and mirrors napi's generated
types next to your `.rs` file. The work runs on real threads **off the Node event
loop**, and the compiled addon travels with your `vite build` output — including
onto serverless platforms like Vercel, with zero code changes.

Rust modules are **server-only**: importing one from code that can reach the
client bundle is a build error by design.

## Why

For a CPU-bound server loader (a 6,000,000-iteration SHA-256 hash chain), moving
the hot path from synchronous JS to an `#[napi] async fn` measured **~2.9× faster
single-request and ~10.7× faster at 5-way concurrency locally**, and **~7× faster
latency with ~7× lower active-CPU cost on Vercel** — same digest either way. Full
methodology and the honest serverless caveats are in the
[benchmarks](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/benchmarks.md).

## Requirements

- Node.js >= 20
- Vite >= 6 (peer dependency)
- `@napi-rs/cli` >= 3 (peer dependency — you install it)
- A Rust toolchain (`cargo` on `PATH`; install from <https://rustup.rs>)
- macOS or Linux — **Windows support is not planned**

Supported frameworks: React Router v7 / v8, vanilla Vite SSR, SvelteKit, and
Astro (Vite 8 / rolldown validated). Next.js and Remix v3 don't run Vite — see
the repo's examples for the plugin-free pattern with the same crate.

## Quickstart

```bash
# 1. scaffold a ready-to-build crate (optional but fastest)
npm create native-rust native

# 2. install the plugin and the napi CLI it drives
npm i -D vite-plugin-native-rust @napi-rs/cli
```

```ts
// 3. vite.config.ts — add the plugin before your framework plugin
import { rustPlugin } from "vite-plugin-native-rust";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [rustPlugin(), /* ...your other plugins */],
});
```

```jsonc
// 4. tsconfig.json compilerOptions — resolve the generated .d.rs.ts types
"allowArbitraryExtensions": true
```

```ts
// 5. import from a server-only module
import { add, sumTo } from "./native/src/lib.rs";

const five = add(2, 3);            // sync, on the main thread
const total = await sumTo(1_000);  // async, off the event loop
```

A cold cargo build (~30s) starts as soon as the dev server boots for crates the
plugin has seen before (see `prewarm` below); otherwise the first dev request
that touches the crate triggers it. Every later request hits the cached addon.

## Options

`rustPlugin(options?)` — every option is optional; defaults reproduce the
zero-argument behavior.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cacheDir` | `string` | `node_modules/.cache/vite-rust` | Where compiled `.node` addons are cached. Relative paths resolve against the Vite root. |
| `profile` | `'debug' \| 'release'` | auto | Force a build profile. Auto = `debug` in dev/watch, `release` in build. |
| `napiArgs` | `string[]` | `[]` | Extra arguments appended to `napi build`. |
| `generateCratePackageJson` | `boolean` | `true` | Write a `package.json` with `napi.binaryName` when the crate lacks one. `false` errors instead of mutating your crate. |
| `emitTypes` | `boolean` | `true` | Mirror napi's generated types to a `.d.rs.ts` beside the imported `.rs`. |
| `logLevel` | `'silent' \| 'info'` | `'info'` | `'silent'` suppresses compile-progress and type-write lines; warnings and errors always show. |
| `prewarm` | `boolean \| string[]` | `true` | Pre-compile known crates when the dev server starts, so a cold cargo build races your first request instead of blocking inside it (some dev servers — e.g. Nitro — time out module fetches at ~60s and cache the failure until restart). `true` pre-warms crates remembered from previous sessions (a small manifest in `cacheDir`, updated on every compile); an array adds explicit anchors — a `.rs` file or crate dir, resolved against the Vite root — for first-ever runs where no manifest exists yet; `false` disables. A request arriving mid-pre-warm joins the in-flight compile instead of starting a second one, and a pre-warm failure is only a warning — the crate falls back to compiling on first import. |

The cache key folds in the crate's full local dependency closure (path deps,
workspace members, the workspace `Cargo.toml`, and the lockfile) plus the `rustc`
and `@napi-rs/cli` versions, so a change anywhere in that set recompiles instead
of serving a stale binary.

## Testing (vitest)

vitest runs its own Vite pipeline, so a `.rs` import parse-fails at collection
unless the plugin is in *that* config too. Add `rustPlugin()` to your
`vitest.config.ts` (or each `test.projects` entry) to test the **real** compiled
crate — it reuses the content-hash cache, so it's cheap after the first run. When
you'd rather not compile Rust (CI without a toolchain), `rustTestStub({ … })`
redirects `.rs` imports to a JS twin:

```ts
import { rustPlugin, rustTestStub } from "vite-plugin-native-rust";
```

Full recipes — including the viral-failure explanation and a `test.projects`
example — are in
[testing.md](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/testing.md).

## Documentation

Full docs live in the
[GitHub repository](https://github.com/kadeangell/vite-plugin-native-rust):

- [How it works](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/how-it-works.md)
- [TypeScript](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/typescript.md)
- [Testing with vitest](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/testing.md)
- [Deploying to Vercel](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/deployment-vercel.md)
- [Benchmarks](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/benchmarks.md)
- [Troubleshooting](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/troubleshooting.md)
- [When not to use this](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/when-not-to-use.md)

## License

MIT © Kade Angell
