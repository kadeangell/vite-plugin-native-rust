#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand may have placed it
# under the root node_modules/.cache/cargo) and run the monorepo build, which
# builds the plugin package to dist/ first and then the example app. The Vite
# plugin shells out to `napi build --release`, which needs cargo on PATH.
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
# Root build fans out: plugin package (dist/) → example app (react-router build).
npm run build
