import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TROUBLESHOOTING_EBADF_URL =
  "https://github.com/kadeangell/vite-plugin-native-rust/blob/main/docs/troubleshooting.md#spawn-ebadf";

/**
 * Open-fd count at which an EBADF/EAGAIN spawn failure stops reading as a
 * momentary flake and starts reading as fd-table exhaustion. Calibrated against
 * the measured data in issue #6: a healthy dev server holds ≈3.4k fds, while
 * child-process spawning begins failing with EBADF past ≈24k on macOS/Node.
 * 8192 sits comfortably above healthy (≈2.4×, so a normal server never trips
 * it) yet well below the ≈24k breaking point — so the leak is named while the
 * table is merely under pressure (spawns can still succeed on a retry), not
 * only once everything is already unspawnable.
 */
export const FD_PRESSURE_THRESHOLD = 8192;

/** Returns this process's open-fd count, or null when it can't be determined. */
export type FdCounter = () => number | null;

/**
 * This process's open-fd count via `/dev/fd` (present on macOS + Linux), or
 * null on any error or a platform without it (Windows is unsupported anyway,
 * so we degrade to null rather than throwing). Cheap — a single readdir — and
 * MUST never throw or slow the spawn hot path. The readdir momentarily costs
 * one fd of its own; irrelevant at the scales that matter here.
 */
export const processFdCount: FdCounter = () => {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
};

/**
 * When `count` indicates fd-table pressure (≥ `FD_PRESSURE_THRESHOLD`), a
 * diagnostic sentence naming the real cause; null below the threshold or when
 * the count is unknown. Shared by every fd-aware failure path so the wording
 * (and the null-below-threshold gate) stays in exactly one place.
 */
export function describeFdPressure(count: number | null): string | null {
  if (count === null || count < FD_PRESSURE_THRESHOLD) return null;
  return (
    `this process is holding ${count} open file descriptors, which breaks ` +
    "child-process spawning. A file watcher or fd leak has exhausted the " +
    "descriptor table (large trees inside a watched directory are the usual " +
    "cause — e.g. a vendored env or a cargo target/ dir under your app). See " +
    TROUBLESHOOTING_EBADF_URL
  );
}

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

/**
 * The direct (non-brokered) spawn: a thin `execFile` wrapper. This is the
 * fallback path whenever the spawn broker (issue #8) is disabled, unavailable,
 * or has died — and the default `exec` for every seam below. A synchronous
 * `spawn EBADF` throw (issue #6) surfaces as a rejection here because the
 * function is `async`, so the existing transient-retry/diagnosis catch works.
 */
export const directExec: ExecFn = async (cmd, args, opts) => {
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
  exec: ExecFn = directExec,
  fdCount: FdCounter = processFdCount,
): Promise<ExecResult> {
  try {
    return await exec(cmd, args, opts);
  } catch (error: unknown) {
    if (!isTransientSpawnError(error)) throw error;
    const code = String((error as { code?: unknown }).code);
    const result = await exec(cmd, args, opts);
    // A recovered retry under fd pressure is the leading edge of total spawn
    // failure — self-diagnose here so the field report carries the count.
    const count = fdCount();
    const pressure =
      count !== null && count >= FD_PRESSURE_THRESHOLD
        ? ` — WARNING: ${count} open fds; spawning will fail entirely as ` +
          `pressure grows (see ${TROUBLESHOOTING_EBADF_URL})`
        : "";
    process.stderr.write(
      `[vite-rust] transient spawn error (${code}) on \`${cmd}\` recovered on ` +
        "retry — if this repeats every session, a native dependency in this " +
        `process may be corrupting file descriptors (see issue #6)${pressure}\n`,
    );
    return result;
  }
}
