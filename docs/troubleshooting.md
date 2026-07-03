# Troubleshooting

Every failure mode below is one that actually came up while building or deploying
this plugin. Each entry is the symptom, the cause, and the fix.

## `cargo` was not found on your PATH

**Symptom:** the plugin errors with
`` `cargo` was not found on your PATH — install Rust from https://rustup.rs. ``

**Cause:** no Rust toolchain is installed, or `cargo` isn't on the `PATH` of the
process running Vite.

**Fix:** install Rust from <https://rustup.rs>, then restart your dev server /
shell so the new `PATH` is picked up. On CI and Vercel, make sure the toolchain
is installed *and* exported into the same shell that runs the build — see
[deployment-vercel.md](deployment-vercel.md), where the build script re-exports
`PATH` because env doesn't persist across the install/build shells.

## `@napi-rs/cli is not installed`

**Symptom:** `@napi-rs/cli is not installed — run \`npm i -D @napi-rs/cli\`.`

**Cause:** `@napi-rs/cli` is a **peer dependency** — you install it, the plugin
doesn't bundle it.

**Fix:**

```bash
npm i -D @napi-rs/cli
```

## napi build fails: "package.json not found"

**Symptom:** a raw napi error like
`Internal Error: package.json not found at <crate>/package.json`, or the plugin's
own message about a missing `napi.binaryName`.

**Cause:** napi v3 refuses to build unless the crate directory contains a
`package.json` carrying a `napi.binaryName` field. `binaryName` also determines
the output filename (`<binaryName>.node`).

**Fix:** by default the plugin writes a minimal one for you
(`{ "napi": { "binaryName": "<dir>" } }`) and logs that it did. If you set
`generateCratePackageJson: false` (so the plugin won't touch your crate), add the
file yourself:

```json
// native/package.json
{ "name": "native", "napi": { "binaryName": "native" } }
```

`create-native-rust` scaffolds this for you.

## "napi build reported success but produced no addon"

**Symptom:** `napi build reported success but produced no addon at
"<crate>/<name>.node"`.

**Cause:** the built binary's name doesn't match the `binaryName` the plugin
expects — usually a mismatch between the crate directory name and
`napi.binaryName` in the crate's `package.json`.

**Fix:** make `napi.binaryName` match what you intend the output to be called; the
plugin derives the expected `<binaryName>.node` from it.

## The first dev request hangs for ~30 seconds

**Symptom:** the first request that touches a Rust crate pauses for tens of
seconds; the plugin logs `compiling crate "<name>"; first build can take 30s+…`.

**Cause:** this is expected. The first request triggers a cold cargo compile —
downloading and building crate dependencies. It is a **dev-only, once-per-source-
change** cost.

**Fix:** none needed — it's working. Subsequent requests hit the content-hash
cache and are instant. If you want the log line gone, set `logLevel: 'silent'`
(the compile still happens; you just won't see the progress line). The production
binary is compiled once at `vite build` time and baked into the output, so users
never pay this.

## A change to a sibling / workspace crate didn't recompile

**Symptom (should be rare now):** you edited a path-dependency or workspace-member
crate and the imported addon served a stale result.

**Cause / status:** this was a real silent-corruption risk and is now fixed. The
plugin runs `cargo metadata` and folds the crate's **full local dependency
closure** — path deps, workspace members, the workspace `Cargo.toml`, and
`Cargo.lock` — into both the watch set and the cache hash. A change anywhere in
that set recompiles.

**If it still happens:** check the dev-server log for a warning that
`cargo metadata` failed and the plugin fell back to single-crate hashing (a
metadata failure degrades gracefully rather than hard-failing dev). Fix whatever
made `cargo metadata` fail (usually a manifest error), and the closure tracking
resumes.

## A stale binary after a Rust toolchain upgrade

**Symptom (should not happen now):** after upgrading `rustc` or `@napi-rs/cli`,
you got a cached binary built by the old toolchain.

**Cause / status:** fixed. The cache key includes a toolchain fingerprint
(`rustc -V` + the resolved `@napi-rs/cli` version), so a toolchain upgrade
invalidates the cache and forces a rebuild even when your source is byte-
identical.

**Fix:** none needed. If you ever want a clean slate anyway, delete
`node_modules/.cache/vite-rust` (or your configured `cacheDir`).

## "Rust modules can only be imported server-side"

**Symptom:** a build error:
`Rust modules can only be imported server-side — import this only from a
.server.ts module …`.

**Cause:** you imported a `.rs` file from a module that can reach the **client**
bundle. Native `.node` binaries cannot ship to the browser, so this is a
deliberate, load-bearing guard — not a bug.

**Fix:** move the import into a server-only module. In React Router, name the file
`*.server.ts` (the framework strips it from the client graph); then import your
route's data from that server module. Never import `.rs` directly from a component
or any module the client graph can reach.

## `tsc` can't resolve the `.rs` import (CI type-check fails)

**Symptom:** `tsc` errors on `import … from "./lib.rs"`, especially in CI.

**Cause:** either `allowArbitraryExtensions` isn't enabled, or the generated
`.d.rs.ts` isn't present (CI has no Rust toolchain to generate it).

**Fix:** enable `"allowArbitraryExtensions": true` in `tsconfig.json`, and
**commit** the generated `<file>.d.rs.ts` so CI resolves types without compiling
Rust. See [typescript.md](typescript.md).

## The served build 500s with `dispatcher.getOwner is not a function`

**Symptom:** every rendered route 500s when you run the built server with
`react-router-serve`.

**Cause:** this is a React dev/prod build mismatch — not addon-related.
`@react-router/serve` must run with `NODE_ENV=production`.

**Fix:** set `NODE_ENV=production` when starting the server. Pin it in your deploy
wrapper. (On Vercel this is moot — the builder generates its own server shim and
you never invoke `react-router-serve`.)

## Windows

**Symptom:** anything on Windows.

**Status:** Windows is **not yet supported**. The addon path handling and build
flow have only been verified on macOS and Linux. Follow the tracking issue for
progress; contributions welcome (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Dev memory creeps up over a long session

**Symptom:** the dev-server process grows slightly in memory the more you edit
Rust.

**Cause:** each Rust edit produces a new content-hashed `.node` filename, so the
dev server `dlopen`s a fresh binary. A `dlopen`'d native library can't be cleanly
unloaded, so the old handles leak. This is inherent to native modules, **dev-only**,
and bounded by your edit count.

**Fix:** none needed for normal use; restart the dev server if a marathon editing
session accumulates enough. Production is unaffected — the build loads exactly one
addon.
