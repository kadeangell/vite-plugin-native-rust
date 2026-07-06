#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand placed the toolchain
# under the root node_modules/.cache) and compile the napi-rs crate to
# native/remixdemo.node for the build machine's target (x86_64 linux). There is
# no app build beyond that — Remix 3 has no bundler, and Vercel's Node builder
# compiles api/index.ts + the app/ modules it imports when packaging the
# function. CARGO_TARGET_DIR is redirected under node_modules/.cache so
# compiled crate artifacts ride Vercel's build cache. (Same pattern as
# examples/react-router.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CARGO_HOME="$REPO_ROOT/node_modules/.cache/cargo"
export RUSTUP_HOME="$REPO_ROOT/node_modules/.cache/rustup"
export CARGO_TARGET_DIR="$REPO_ROOT/node_modules/.cache/cargo-target"
export PATH="$CARGO_HOME/bin:$PATH"

cargo --version

cd "$REPO_ROOT"
npm run build:native -w example-remix-v3

# Pre-bundle the TS/JSX app for the function: the remix/node-tsx runtime
# loader is unavailable inside Vercel functions, and Vercel's Node builder
# does not compile the app's .tsx modules — so esbuild does (remix itself
# stays external and is traced into node_modules by @vercel/nft). The
# committed api/index.mjs imports the resulting dist/app.mjs.
npm run build:vercel-bundle -w example-remix-v3

# Vercel's "Other" preset publishes public/ (which must be non-empty — it
# holds robots.txt) as static files and packages api/index.mjs as the
# catch-all function.
