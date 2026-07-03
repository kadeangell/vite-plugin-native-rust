#![deny(clippy::all)]

use napi_derive::napi;
use sha2::{Digest, Sha256};

const SEED: &[u8] = b"vite-rust-import-plugin";

/// CPU-bound SHA-256 hash chain, mirroring heavy.server.ts::heavyHashChain.
///
/// `async` so napi runs it on the libuv thread pool: the Node event loop is
/// never blocked while this churns. Returns the final digest as a hex string.
#[napi]
pub async fn hash_chain(iterations: u32) -> String {
    let mut buffer = SEED.to_vec();
    for _ in 0..iterations {
        let digest = Sha256::digest(&buffer);
        buffer = digest.to_vec();
    }
    hex::encode(buffer)
}

/// Trivial synchronous export — exists so the plugin can exercise
/// named-export enumeration over a mix of sync/async functions.
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
