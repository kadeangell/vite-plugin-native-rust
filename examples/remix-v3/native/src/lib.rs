#![deny(clippy::all)]

use napi_derive::napi;

/// Adds two integers on the main thread.
///
/// A trivial **synchronous** export: it returns immediately, so there is no
/// benefit to running it off-thread. Reach for this shape when the work is
/// cheap and non-blocking.
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Sums `0..=n`, off the main thread.
///
/// Marked `async` so napi runs it on the libuv thread pool: the Node event
/// loop stays free while this churns, so slow CPU-bound work here never blocks
/// other requests. This is the shape to reach for with heavy computation.
///
/// Returned as `f64` (JS `number`) to sidestep integer overflow for large `n`.
#[napi]
pub async fn sum_to(n: u32) -> f64 {
    let mut total: f64 = 0.0;
    for i in 0..=n {
        total += f64::from(i);
    }
    total
}
