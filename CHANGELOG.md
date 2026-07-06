# Changelog

## 0.1.1 (2026-07-06)

### vite-plugin-native-rust

- Docs only: the packaged README now states that Windows support is not
  planned (0.1.0 shipped the older "not yet supported" wording). No code
  changes.

## 0.1.0 (2026-07-03)

Initial public release. Experimental — the API may change before 0.2.

### vite-plugin-native-rust

- Import Rust crates directly from Vite SSR server code
  (`import { fn } from "./crate/src/lib.rs"`): compiles the enclosing
  napi-rs crate to a native `.node` addon, generates typed named exports,
  and loads the binary at runtime off the Node event loop.
- Content-hash compile cache covering the crate's **full local dependency
  closure** (path deps, workspace members, workspace manifest, lockfile —
  via `cargo metadata`) plus the `rustc` and `@napi-rs/cli` versions.
- Server-only enforcement: importing `.rs` from client-reachable code is a
  build error.
- TypeScript support: mirrors napi's generated `.d.ts` to `<file>.d.rs.ts`
  (`allowArbitraryExtensions`).
- Build-mode asset emission that survives bundlers and serverless file
  tracing (verified on Vercel with zero config changes); sets
  `build.ssrEmitAssets` so bare `vite build --ssr` ships the addon.
- Options: `cacheDir`, `profile`, `napiArgs`, `generateCratePackageJson`,
  `emitTypes`, `logLevel`.
- Atomic cache writes; cross-process safe.
- Supported: Vite >= 6 (tested through the Vite 8 Environment API via
  React Router v8), React Router v7/v8, vanilla Vite SSR, macOS/Linux,
  Node >= 20. Windows support is not planned.

### create-native-rust

- `npm create native-rust <dir>` scaffolds a ready-to-build napi-rs crate
  (cdylib, napi v3, required `napi.binaryName` package.json, async + sync
  sample exports) and prints the wiring steps.
