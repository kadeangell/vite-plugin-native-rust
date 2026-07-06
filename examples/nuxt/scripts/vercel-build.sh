#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand placed it under the
# root node_modules/.cache/cargo) and build the plugin package (dist/) followed
# by this Nuxt example. The plugin shells out to `napi build --release`, which
# needs cargo on PATH; env from installCommand does not persist into
# buildCommand (separate shells), so this script re-exports it.
# CARGO_TARGET_DIR is redirected under node_modules/.cache so compiled crate
# artifacts also ride Vercel's build cache.
#
# On Vercel, Nitro auto-detects the `vercel` preset (VERCEL env) and writes the
# Build Output API directory at examples/nuxt/.vercel/output, which matches the
# project's Root Directory — Vercel deploys it as-is.
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
npm run build -w example-nuxt
