// Bench slot for the "hashing" demo (see benchmarks.server.ts contract).
// Owned exclusively by that demo — other agents must not touch this file.
//
// Three rows, all computing an Argon2id hash with IDENTICAL cost parameters
// (64 MiB, t=3, p=1, 32-byte output — see ARGON2_PARAMS):
//   1. native async  — the shape the demo recommends shipping
//   2. native sync   — same Rust work on the main thread; per-call latency is
//                      the same, but it holds the event loop hostage while it
//                      runs (the /hashing experiment shows that part)
//   3. hash-wasm     — the strongest JS-installable baseline (wasm argon2id)
//
// Each run costs ~100 ms BY DESIGN (that's the security property), so the
// iteration count is deliberately tiny: n=5 keeps the live /benchmarks page
// responsive while still giving a stable median.

import { argon2id } from "hash-wasm";
import { randomBytes } from "node:crypto";

import type { BenchSuite } from "../benchmarks.server";
import { timeIt } from "../lib/bench.server";
import {
  ARGON2_PARAMS,
  hashPassword,
  hashPasswordSync,
} from "../hashing.server";

const ITERATIONS = 5;
const BENCH_PASSWORD = "correct horse battery staple";
const SALT_BYTES = 16;

// Same cost parameters as the Rust crate; hash-wasm wants an explicit salt
// (the crate generates its own internally — both are 16 bytes of OS entropy).
function hashWithWasm(): Promise<string> {
  return argon2id({
    password: BENCH_PASSWORD,
    salt: randomBytes(SALT_BYTES),
    memorySize: ARGON2_PARAMS.memoryKib,
    iterations: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.hashLengthBytes,
    outputType: "encoded",
  });
}

export const suite: BenchSuite | null = {
  id: "hashing",
  title:
    "Password hashing — argon2 (native) vs hash-wasm, identical Argon2id params",
  run: async () => [
    await timeIt(
      "rust argon2 — async (off the event loop)",
      () => hashPassword(BENCH_PASSWORD),
      ITERATIONS,
    ),
    await timeIt(
      "rust argon2 — sync (blocks the event loop while it runs)",
      () => hashPasswordSync(BENCH_PASSWORD),
      ITERATIONS,
    ),
    await timeIt("hash-wasm argon2id (wasm)", hashWithWasm, ITERATIONS),
  ],
};
