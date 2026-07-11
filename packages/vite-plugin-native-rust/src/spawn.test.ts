import assert from "node:assert/strict";
import { test } from "node:test";

import { assertCargoAvailable } from "./compile.ts";
import {
  describeFdPressure,
  execFileTransientRetry,
  FD_PRESSURE_THRESHOLD,
  isCommandNotFound,
  isTransientSpawnError,
  processFdCount,
  type ExecFn,
  type FdCounter,
} from "./spawn.ts";

const err = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn ${code}`), { code });

/** A fixed fd counter for injection; `HIGH` is above the pressure threshold. */
const HIGH_FD = FD_PRESSURE_THRESHOLD + 4321;
const fdIs = (count: number | null): FdCounter => () => count;

/** Capture everything written to process.stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

function execSeq(outcomes: Array<string | null>): ExecFn & { calls: number } {
  const state = { calls: 0 };
  const fn: ExecFn = async () => {
    const outcome = outcomes[state.calls];
    state.calls += 1;
    if (outcome === null) return { stdout: "ok", stderr: "" };
    throw err(outcome);
  };
  Object.defineProperty(fn, "calls", { get: () => state.calls });
  return fn as ExecFn & { calls: number };
}

test("transient EBADF gets exactly one retry, then succeeds", async () => {
  const exec = execSeq(["EBADF", null]);
  const result = await execFileTransientRetry("cargo", ["--version"], undefined, exec);
  assert.equal(result.stdout, "ok");
  assert.equal(exec.calls, 2);
});

test("persistent EBADF throws after the single retry", async () => {
  const exec = execSeq(["EBADF", "EBADF"]);
  await assert.rejects(
    execFileTransientRetry("cargo", ["--version"], undefined, exec),
    (e: NodeJS.ErrnoException) => e.code === "EBADF",
  );
  assert.equal(exec.calls, 2);
});

test("ENOENT is not retried", async () => {
  const exec = execSeq(["ENOENT"]);
  await assert.rejects(execFileTransientRetry("x", [], undefined, exec));
  assert.equal(exec.calls, 1);
});

test("classifiers distinguish not-found from transient", () => {
  assert.equal(isCommandNotFound(err("ENOENT")), true);
  assert.equal(isCommandNotFound(err("EBADF")), false);
  assert.equal(isTransientSpawnError(err("EBADF")), true);
  assert.equal(isTransientSpawnError(err("EAGAIN")), true);
  assert.equal(isTransientSpawnError(err("ENOENT")), false);
  assert.equal(isTransientSpawnError(new Error("plain")), false);
});

test("assertCargoAvailable: ENOENT gets the rustup message", async () => {
  await assert.rejects(assertCargoAvailable(execSeq(["ENOENT"])), /rustup\.rs/);
});

test("assertCargoAvailable: persistent EBADF reports the real code, not not-found", async () => {
  await assert.rejects(
    assertCargoAvailable(execSeq(["EBADF", "EBADF"])),
    (e: Error) =>
      e.message.includes("EBADF") &&
      e.message.includes("transient") &&
      !e.message.includes("was not found"),
  );
});

test("assertCargoAvailable: transient blip recovers silently", async () => {
  await captureStderr(() => assertCargoAvailable(execSeq(["EBADF", null])));
});

test("assertCargoAvailable: persistent EBADF + fd pressure names the fd count as the cause", async () => {
  await assert.rejects(
    assertCargoAvailable(execSeq(["EBADF", "EBADF"]), fdIs(HIGH_FD)),
    (e: Error) =>
      e.message.includes(String(HIGH_FD)) &&
      e.message.includes("open file descriptors") &&
      e.message.includes("EBADF") &&
      !e.message.includes("was not found"),
  );
});

test("assertCargoAvailable: persistent EBADF with a healthy fd count keeps the transient wording", async () => {
  await assert.rejects(
    assertCargoAvailable(execSeq(["EBADF", "EBADF"]), fdIs(3400)),
    (e: Error) =>
      e.message.includes("transient") &&
      !e.message.includes("file descriptors") &&
      !e.message.includes("3400"),
  );
});

test("assertCargoAvailable: an unknown fd count (null) falls back to the transient wording", async () => {
  await assert.rejects(
    assertCargoAvailable(execSeq(["EBADF", "EBADF"]), fdIs(null)),
    (e: Error) =>
      e.message.includes("transient") && !e.message.includes("file descriptors"),
  );
});

test("recovered retry under fd pressure logs the fd count as a warning", async () => {
  const exec = execSeq(["EBADF", null]);
  const out = await captureStderr(async () => {
    await execFileTransientRetry("cargo", ["--version"], undefined, exec, fdIs(HIGH_FD));
  });
  assert.match(out, /recovered on retry/);
  assert.match(out, new RegExp(`WARNING: ${HIGH_FD} open fds`));
});

test("recovered retry with a healthy fd count logs no fd warning", async () => {
  const exec = execSeq(["EBADF", null]);
  const out = await captureStderr(async () => {
    await execFileTransientRetry("cargo", ["--version"], undefined, exec, fdIs(3400));
  });
  assert.match(out, /recovered on retry/);
  assert.doesNotMatch(out, /WARNING/);
  assert.doesNotMatch(out, /open fds/);
});

test("describeFdPressure gates on the threshold and returns null below it", () => {
  assert.equal(describeFdPressure(null), null);
  assert.equal(describeFdPressure(FD_PRESSURE_THRESHOLD - 1), null);
  const above = describeFdPressure(FD_PRESSURE_THRESHOLD);
  assert.ok(above !== null && above.includes(String(FD_PRESSURE_THRESHOLD)));
  assert.ok(above.includes("open file descriptors"));
});

test("processFdCount returns a plausible positive integer on this platform", () => {
  const count = processFdCount();
  // macOS/Linux CI both expose /dev/fd; a live process always holds a handful.
  assert.equal(typeof count, "number");
  assert.ok(Number.isInteger(count) && (count as number) > 0);
  // A test process is nowhere near the pressure threshold.
  assert.ok((count as number) < FD_PRESSURE_THRESHOLD);
});
