import assert from "node:assert/strict";
import { test } from "node:test";

import { dedupeInFlight } from "./dedupe.ts";

/** A promise plus its resolve/reject handles, so tests control settle timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent calls with the same key share one in-flight promise", async () => {
  const d = deferred<number>();
  let calls = 0;
  const fn = () => {
    calls++;
    return d.promise;
  };

  const a = dedupeInFlight("k", fn);
  const b = dedupeInFlight("k", fn);

  assert.equal(calls, 1, "fn runs once for concurrent callers");
  assert.equal(a, b, "callers receive the identical promise");

  d.resolve(42);
  assert.equal(await a, 42);
  assert.equal(await b, 42);
});

test("different keys do not share a promise", async () => {
  let calls = 0;
  const fn = () => {
    calls++;
    return Promise.resolve(calls);
  };

  const a = dedupeInFlight("one", fn);
  const b = dedupeInFlight("two", fn);

  assert.notEqual(a, b);
  assert.equal(calls, 2);
  await Promise.all([a, b]);
});

test("a rejected compile clears the entry so it can be retried", async () => {
  let calls = 0;
  const first = deferred<string>();
  const fn = () => {
    calls++;
    return calls === 1 ? first.promise : Promise.resolve("ok");
  };

  const failing = dedupeInFlight("retry", fn);
  first.reject(new Error("boom"));
  await assert.rejects(failing, /boom/);

  // Entry must be gone, so a fresh call actually re-invokes fn.
  const retry = dedupeInFlight("retry", fn);
  assert.equal(calls, 2, "fn re-invoked after the prior rejection settled");
  assert.equal(await retry, "ok");
});

test("after a successful settle the same key re-invokes fn", async () => {
  let calls = 0;
  const fn = () => {
    calls++;
    return Promise.resolve(calls);
  };

  assert.equal(await dedupeInFlight("done", fn), 1);
  assert.equal(await dedupeInFlight("done", fn), 2, "no stale sharing post-settle");
});
