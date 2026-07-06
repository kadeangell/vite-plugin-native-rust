#!/usr/bin/env bash
# Vercel installCommand: install the whole npm workspace from the monorepo
# root, then ensure a usable Rust toolchain so `napi build` can compile the
# crate on-target during the build step.
#
# This example is deployed with the Vercel project's Root Directory set to
# `examples/nextjs` and "Include files outside the Root Directory" enabled, so
# the command runs with cwd = examples/nextjs but the full monorepo is
# present. We resolve the repo root relative to this script.
#
# The Vercel build image already ships rustup (/rust/bin) but with NO default
# toolchain configured. We point CARGO_HOME/RUSTUP_HOME at the root
# node_modules/.cache (which Vercel persists in its build cache) and install a
# minimal stable toolchain there, so warm builds restore it instead of
# re-downloading.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

npm install

export CARGO_HOME="$REPO_ROOT/node_modules/.cache/cargo"
export RUSTUP_HOME="$REPO_ROOT/node_modules/.cache/rustup"

if ! command -v rustup >/dev/null 2>&1; then
  echo "[vercel-install] no rustup on image — bootstrapping it into the cache"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --no-modify-path --default-toolchain none
fi

export PATH="$CARGO_HOME/bin:$PATH"

echo "[vercel-install] rustup: $(command -v rustup); RUSTUP_HOME=$RUSTUP_HOME"
rustup set profile minimal
rustup toolchain install stable
rustup default stable

cargo --version
