#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand placed it under the
# root node_modules/.cache/cargo) and build the plugin package (dist/) followed
# by this Astro example. The Vite plugin shells out to `napi build --release`,
# which needs cargo on PATH. CARGO_TARGET_DIR is redirected under
# node_modules/.cache so compiled crate artifacts also ride Vercel's build
# cache.
#
# Note: this builds `-w vite-plugin-native-rust -w example-astro` explicitly
# instead of the root `npm run build`, which builds the react-router example.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CARGO_HOME="$REPO_ROOT/node_modules/.cache/cargo"
export RUSTUP_HOME="$REPO_ROOT/node_modules/.cache/rustup"
export CARGO_TARGET_DIR="$REPO_ROOT/node_modules/.cache/cargo-target"
export PATH="$CARGO_HOME/bin:$PATH"

cargo --version

cd "$REPO_ROOT"
npm run build -w vite-plugin-native-rust
npm run build -w example-astro
