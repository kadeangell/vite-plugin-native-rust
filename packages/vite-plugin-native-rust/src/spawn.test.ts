import assert from "node:assert/strict";
import { test } from "node:test";

import { assertCargoAvailable } from "./compile.ts";
import {
  execFileTransientRetry,
  isCommandNotFound,
  isTransientSpawnError,
  type ExecFn,
} from "./spawn.ts";

const err = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`spawn ${code}`), { code });

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
  await assertCargoAvailable(execSeq(["EBADF", null]));
});
