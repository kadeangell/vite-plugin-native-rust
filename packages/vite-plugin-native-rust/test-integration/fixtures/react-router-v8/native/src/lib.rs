#![deny(clippy::all)]

use napi_derive::napi;

/// Sync export: adds two integers on the calling thread.
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Async export: sums `0..=n` on the libuv thread pool. Returned as `f64` so
/// large `n` cannot overflow. Tiny by design — the integration suite wants a
/// crate that compiles in seconds.
#[napi]
pub async fn sum_to(n: u32) -> f64 {
    let mut total: f64 = 0.0;
    for i in 0..=n {
        total += f64::from(i);
    }
    total
}
