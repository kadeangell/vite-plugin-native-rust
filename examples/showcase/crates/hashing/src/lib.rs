#![deny(clippy::all)]

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use napi::{Error, Result, Status};
use napi_derive::napi;
use rand_core::OsRng;

/// Argon2id parameters, tuned so one hash costs on the order of 100 ms
/// (~70–100 ms measured on an Apple-silicon core) — deliberately slow,
/// because that slowness is the security property.
///
/// - memory: 64 MiB (65536 KiB), iterations (t): 3 — RFC 9106's recommended
///   low-memory configuration
/// - parallelism (p): 1 — RFC 9106 pairs it with p=4, but this crate computes
///   lanes sequentially and so does hash-wasm, so p=1 keeps the native-vs-wasm
///   A/B running byte-identical sequential work
///
/// The JS side mirrors these numbers for the hash-wasm baseline; if you change
/// them here, change `ARGON2_PARAMS` in `app/hashing.server.ts` too.
const MEMORY_KIB: u32 = 64 * 1024;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;
const OUTPUT_LEN: usize = 32;

fn argon2() -> Result<Argon2<'static>> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, PARALLELISM, Some(OUTPUT_LEN))
        .map_err(|e| Error::new(Status::GenericFailure, format!("bad argon2 params: {e}")))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn hash_with_fresh_salt(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2()?
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| Error::new(Status::GenericFailure, format!("argon2 hashing failed: {e}")))
}

/// Hashes a password with Argon2id — **synchronously, on the main thread**.
///
/// This export exists to demonstrate the anti-pattern: a plain (non-async)
/// `#[napi]` fn runs on the Node.js main thread, so the ~100 ms of deliberate
/// argon2 work blocks the event loop for its entire duration. N concurrent
/// calls serialize into N × 100 ms of a completely unresponsive server.
/// Don't ship this shape for slow work — see `hash_password`.
#[napi]
pub fn hash_password_sync(password: String) -> Result<String> {
    hash_with_fresh_salt(&password)
}

/// Hashes a password with Argon2id — **async, off the event loop**.
///
/// `async fn` makes napi-rs run the hash on its worker pool and hand JS a
/// `Promise<string>`. The event loop stays free: N concurrent calls run in
/// parallel across cores, finishing in ~1 × 100 ms wall time while the server
/// keeps serving other requests. This is the shape to ship.
///
/// Returns a PHC-format string (`$argon2id$v=19$m=65536,t=3,p=1$...`) that
/// embeds the salt and parameters, ready to store as-is.
#[napi]
pub async fn hash_password(password: String) -> Result<String> {
    hash_with_fresh_salt(&password)
}

/// Verifies a password against a stored PHC-format hash, off the event loop.
///
/// Demonstrates Rust `Result` → JS exception propagation:
/// - wrong password → resolves `false` (an expected outcome, not an error)
/// - malformed / corrupted hash string → returns `Err`, which napi-rs turns
///   into a **rejected Promise** — a normal catchable JS exception carrying
///   this message. No panics, no process crashes.
#[napi]
pub async fn verify_password(password: String, hash: String) -> Result<bool> {
    let parsed = PasswordHash::new(&hash).map_err(|e| {
        Error::new(
            Status::InvalidArg,
            format!("not a valid PHC hash string: {e}"),
        )
    })?;
    match argon2()?.verify_password(password.as_bytes(), &parsed) {
        Ok(()) => Ok(true),
        Err(argon2::password_hash::Error::Password) => Ok(false),
        Err(e) => Err(Error::new(
            Status::GenericFailure,
            format!("verification failed: {e}"),
        )),
    }
}
