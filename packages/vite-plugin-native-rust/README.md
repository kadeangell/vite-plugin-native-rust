# vite-plugin-native-rust

> **Experimental — 0.1.** The API may change before 0.2.

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

Supported frameworks: React Router v7 / v8 and vanilla Vite SSR.

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

The first dev request that touches the crate triggers a cargo build (~30s cold,
cached after). Every later request hits the cached addon.

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

The cache key folds in the crate's full local dependency closure (path deps,
workspace members, the workspace `Cargo.toml`, and the lockfile) plus the `rustc`
and `@napi-rs/cli` versions, so a change anywhere in that set recompiles instead
of serving a stale binary.

## Documentation

Full docs live in the
[GitHub repository](https://github.com/kadeangell/vite-plugin-native-rust):

- [How it works](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/how-it-works.md)
- [TypeScript](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/typescript.md)
- [Deploying to Vercel](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/deployment-vercel.md)
- [Benchmarks](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/benchmarks.md)
- [Troubleshooting](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/troubleshooting.md)
- [When not to use this](https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/when-not-to-use.md)

## License

MIT © Kade Angell
