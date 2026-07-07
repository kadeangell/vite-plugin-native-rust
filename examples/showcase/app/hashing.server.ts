// Server-only entry point for the `hashing` demo crate (argon2). The
// `.server.ts` suffix keeps the `.rs` import out of the client graph.
//
// Three exports from ~90 lines of Rust:
//   hashPasswordSync — deliberately-sync #[napi] fn (the event-loop anti-pattern)
//   hashPassword     — async #[napi] fn, runs on napi's worker pool
//   verifyPassword   — async; malformed hash -> rejected Promise (Result -> exception)
import {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
} from "../crates/hashing/src/lib.rs";

export { hashPassword, hashPasswordSync, verifyPassword };

// Mirror of the Argon2id cost parameters hard-coded in crates/hashing/src/lib.rs.
// The hash-wasm baseline in app/benches/hashing.server.ts uses these so the
// wasm-vs-native comparison runs the exact same amount of work. Keep in sync
// with the Rust constants (MEMORY_KIB / ITERATIONS / PARALLELISM / OUTPUT_LEN).
export const ARGON2_PARAMS = {
  memoryKib: 64 * 1024, // 64 MiB + t=3 — RFC 9106 low-memory recommendation
  iterations: 3,
  parallelism: 1, // both implementations compute lanes sequentially
  hashLengthBytes: 32,
} as const;
