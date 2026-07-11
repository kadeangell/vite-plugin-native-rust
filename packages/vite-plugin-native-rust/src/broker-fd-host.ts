/**
 * Killer-regression host for the spawn broker (issue #8) — NOT a test file, and
 * not a build entry. It is spawned by `broker.test.ts` as its own Node process
 * (under a raised `ulimit -n`) so the 24,500-open-fd poisoning happens in a
 * throwaway process, never in the test runner itself.
 *
 * Sequence (order matters):
 *   1. fork the broker while this process's fd table is still clean;
 *   2. pick the command to run (cargo if present, else this node binary) — the
 *      EBADF failure is command-agnostic, so a machine without cargo still
 *      proves the mechanism;
 *   3. open 24,500 fds on /dev/null to reproduce the issue-#6 poisoning;
 *   4. run the command *through the broker* (must succeed — its child's fd
 *      table is clean) and *directly* (must fail `spawn EBADF` on macOS — this
 *      asserts the poisoning is real, not a no-op test);
 *   5. emit a single `__RESULT__<json>` line the parent parses.
 *
 * The child entry path is taken from `BROKER_CHILD_PATH` so the parent can
 * point it at the `.ts` source (type-stripped) during unit tests.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import { startBroker } from "./broker.ts";
import { directExec, type ExecFn } from "./spawn.ts";

const TARGET_FDS = 24_500;

function codeOf(error: unknown): string | number | undefined {
  return (error as { code?: string | number } | null)?.code;
}

/** cargo if it is on PATH (probed while the fd table is clean), else node. */
function pickCommand(): { cmd: string; args: string[] } {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return { cmd: "cargo", args: ["--version"] };
  } catch {
    return { cmd: process.execPath, args: ["--version"] };
  }
}

async function runLeg(
  exec: ExecFn,
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; code?: string | number; stdout?: string }> {
  try {
    const { stdout } = await exec(cmd, args);
    return { ok: true, stdout: stdout.trim().slice(0, 60) };
  } catch (error: unknown) {
    return { ok: false, code: codeOf(error) };
  }
}

async function main(): Promise<void> {
  // Force `process.stdout`'s lazy socket to initialize NOW, while the fd table
  // is still clean. Under a low `kern.maxfilesperproc` (some CI macOS runners)
  // the poisoning loop can consume every last fd, and creating stdout later —
  // it needs a fresh fd — would then throw EMFILE before the result is written.
  process.stdout.write("");

  const childPath = process.env.BROKER_CHILD_PATH;
  const broker = startBroker(childPath ? { childPath } : {});
  if (!broker) {
    process.stdout.write(`__RESULT__${JSON.stringify({ error: "broker-null" })}\n`);
    return;
  }

  const { cmd, args } = pickCommand();

  // Poison this process's fd table exactly as issue #6 does. A runner whose
  // ceiling is below the ~24k EBADF cliff hits EMFILE first (recorded, not
  // fatal) — the parent test skips the direct-fails assertion in that case.
  const held: number[] = [];
  let openError: string | number | undefined;
  for (let i = 0; i < TARGET_FDS; i++) {
    try {
      held.push(openSync("/dev/null", "r"));
    } catch (error: unknown) {
      openError = codeOf(error);
      break;
    }
  }

  const brokered = await runLeg(broker.exec, cmd, args);
  const direct = await runLeg(directExec, cmd, args);

  broker.dispose();

  // Release the fds before printing: the result line goes through stdout, and a
  // still-full table can block any fd the write path needs on a constrained
  // runner.
  for (const fd of held) {
    try {
      closeSync(fd);
    } catch {
      // best effort — we're exiting anyway
    }
  }

  process.stdout.write(
    `__RESULT__${JSON.stringify({
      heldFds: held.length,
      reachedThreshold: held.length >= TARGET_FDS,
      openError,
      cmd,
      brokered,
      direct,
    })}\n`,
  );
  process.exit(0);
}

void main();
