#!/usr/bin/env bash
# Vercel buildCommand: put cargo on PATH (installCommand may have placed it
# under node_modules/.cache/cargo) and run the normal RRv7 build. The Vite
# plugin shells out to `napi build --release`, which needs cargo on PATH.
# CARGO_TARGET_DIR is redirected under node_modules/.cache so compiled crate
# artifacts also ride Vercel's build cache.
set -euo pipefail

export CARGO_HOME="$PWD/node_modules/.cache/cargo"
export RUSTUP_HOME="$PWD/node_modules/.cache/rustup"
export CARGO_TARGET_DIR="$PWD/node_modules/.cache/cargo-target"
export PATH="$CARGO_HOME/bin:$PATH"

cargo --version

npm run build
