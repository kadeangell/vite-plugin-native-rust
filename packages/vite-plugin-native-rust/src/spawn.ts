import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Spawn-level error codes that are transient on macOS + recent Node: stdio
 * pipe fds can be invalidated while the spawn is being set up (documented
 * across the ecosystem — vitejs/vite#18527, nuxt/nuxt#29744; see issue #6).
 * A single retry converts the flake into a non-event. Cargo's own non-zero
 * exits carry a numeric `code` (or stderr) and are NEVER retried.
 */
const TRANSIENT_SPAWN_CODES = new Set(["EBADF", "EAGAIN"]);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; maxBuffer?: number },
) => Promise<ExecResult>;

const defaultExec: ExecFn = async (cmd, args, opts) => {
  const { stdout, stderr } = await execFileAsync(cmd, args, opts);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** True when `error` is a transient spawn-level failure (not a command exit). */
export function isTransientSpawnError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && TRANSIENT_SPAWN_CODES.has(code);
}

/** True when `error` means the executable genuinely doesn't exist on PATH. */
export function isCommandNotFound(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "ENOENT";
}

/**
 * `execFile` with ONE retry when the failure is a transient spawn error.
 * Everything else — ENOENT, non-zero exits, real crashes — propagates
 * immediately and untouched. A recovered retry is LOGGED (issue #6): field
 * reports need to reveal whether an environment's EBADF is first-spawn-only
 * (poisoned fd table absorbed by the retry) or a one-off flake.
 */
export async function execFileTransientRetry(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; maxBuffer?: number },
  exec: ExecFn = defaultExec,
): Promise<ExecResult> {
  try {
    return await exec(cmd, args, opts);
  } catch (error: unknown) {
    if (!isTransientSpawnError(error)) throw error;
    const code = String((error as { code?: unknown }).code);
    const result = await exec(cmd, args, opts);
    process.stderr.write(
      `[vite-rust] transient spawn error (${code}) on \`${cmd}\` recovered on ` +
        "retry — if this repeats every session, a native dependency in this " +
        "process may be corrupting file descriptors (see issue #6)\n",
    );
    return result;
  }
}
