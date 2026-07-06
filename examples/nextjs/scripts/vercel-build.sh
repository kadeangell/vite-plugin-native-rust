#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand placed the toolchain
# under the root node_modules/.cache) and build the example. The `prebuild`
# script shells out to `napi build --release --platform --cwd native`, which
# needs cargo on PATH; env from installCommand does not persist into
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
# prebuild (napi build --release --platform) → next build, cwd examples/nextjs.
npm run build -w example-nextjs
