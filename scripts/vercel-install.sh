#!/usr/bin/env bash
# Vercel installCommand: install JS deps, then ensure a usable Rust toolchain.
#
# The Vercel build image already ships rustup (/rust/bin) but with NO default
# toolchain configured. We point CARGO_HOME/RUSTUP_HOME at node_modules/.cache
# (which Vercel persists in its build cache) and install a minimal stable
# toolchain there, so warm builds restore it instead of re-downloading.
set -euo pipefail

npm install

export CARGO_HOME="$PWD/node_modules/.cache/cargo"
export RUSTUP_HOME="$PWD/node_modules/.cache/rustup"

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
