// Pure template functions. Each returns freshly-built file content for a crate
// named `name`; nothing here mutates shared state. The generated crate mirrors
// the verified-known-good `examples/react-router/native` template: a cdylib
// with napi v3 + napi-derive v3, a `napi_build::setup()` build script, and the
// `napi.binaryName` package.json that napi v3 hard-requires (SPIKE-FINDINGS.md
// gotcha #1).

/**
 * Cargo.toml — cdylib crate-type, napi v3 with the same feature flags the
 * example crate uses, and a release profile with lto + symbol stripping.
 */
export function cargoToml(name) {
  return `[package]
name = "${name}"
version = "0.0.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3", default-features = false, features = ["napi4", "async"] }
napi-derive = "3"

[build-dependencies]
napi-build = "2"

[profile.release]
lto = true
strip = "symbols"
`;
}

/** build.rs — napi's codegen hook. */
export function buildRs() {
  return `fn main() {
    napi_build::setup();
}
`;
}

/**
 * src/lib.rs — one async sample export and one sync sample export, both
 * doc-commented so the generated `.d.ts` carries the docs through to editors.
 */
export function libRs() {
  return `#![deny(clippy::all)]

use napi_derive::napi;

/// Adds two integers on the main thread.
///
/// A trivial **synchronous** export: it returns immediately, so there is no
/// benefit to running it off-thread. Reach for this shape when the work is
/// cheap and non-blocking.
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Sums \`0..=n\`, off the main thread.
///
/// Marked \`async\` so napi runs it on the libuv thread pool: the Node event
/// loop stays free while this churns, so slow CPU-bound work here never blocks
/// other requests. This is the shape to reach for with heavy computation.
///
/// Returned as \`f64\` (JS \`number\`) to sidestep integer overflow for large \`n\`.
#[napi]
pub async fn sum_to(n: u32) -> f64 {
    let mut total: f64 = 0.0;
    for i in 0..=n {
        total += f64::from(i);
    }
    total
}
`;
}

/**
 * The crate's package.json. napi v3 refuses to build without a package.json
 * carrying a `napi.binaryName` (SPIKE-FINDINGS.md gotcha #1); `binaryName`
 * also determines the output filename (`<binaryName>.node`).
 */
export function cratePackageJson(name) {
  return `${JSON.stringify(
    {
      name,
      version: "0.0.0",
      private: true,
      napi: { binaryName: name },
    },
    null,
    2,
  )}\n`;
}

/** .gitignore — keep cargo build output and compiled addons out of git. */
export function gitignore() {
  return `target/
*.node
`;
}

/**
 * The full file set for a crate named `name`, as a fresh map of
 * relative-path -> contents.
 */
export function crateFiles(name) {
  return {
    "Cargo.toml": cargoToml(name),
    "build.rs": buildRs(),
    "src/lib.rs": libRs(),
    "package.json": cratePackageJson(name),
    ".gitignore": gitignore(),
  };
}
