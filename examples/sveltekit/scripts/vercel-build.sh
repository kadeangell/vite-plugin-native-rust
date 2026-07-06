#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand placed it under the
# root node_modules/.cache/cargo) and build the plugin dist followed by this
# example. The Vite plugin shells out to `napi build --release`, which needs
# cargo on PATH — and env from installCommand does NOT persist into
# buildCommand (separate shells), so this script re-exports it.
# CARGO_TARGET_DIR is redirected under node_modules/.cache so compiled crate
# artifacts also ride Vercel's build cache.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

export CARGO_HOME="$REPO_ROOT/node_modules/.cache/cargo"
export RUSTUP_HOME="$REPO_ROOT/node_modules/.cache/rustup"
export CARGO_TARGET_DIR="$REPO_ROOT/node_modules/.cache/cargo-target"
export PATH="$CARGO_HOME/bin:$PATH"

cargo --version

cd "$REPO_ROOT"
# Build the plugin package to dist/ first, then this example. `vite build`
# runs the SvelteKit build and @sveltejs/adapter-vercel writes the Build
# Output API v3 directory at examples/sveltekit/.vercel/output.
npm run build -w vite-plugin-native-rust
npm run build -w example-sveltekit
