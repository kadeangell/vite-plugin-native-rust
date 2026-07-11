/**
 * Spawn-broker sidecar (issue #8) — the host half.
 *
 * `startBroker` forks {@link broker-child} while the dev-server process's fd
 * table is still small, then hands back an {@link ExecFn} that ships every
 * subsequent subprocess to that clean child over the already-open IPC channel.
 * The child spawns cargo with an uncontaminated fd table, so compiles keep
 * working even after the host is poisoned past the ≈24k-fd EBADF cliff
 * (issue #6). When the broker is disabled, fails to start, or dies, the caller
 * falls back to direct spawning with the existing 0.3.5 retry + fd diagnosis.
 */
import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ExecFn, ExecResult } from "./spawn.ts";

/** Mirrors the child's reply shape (see broker-child.ts). */
type BrokerReply =
  | { id: number; ok: true; stdout: string; stderr: string }
  | {
      id: number;
      ok: false;
      code?: string | number;
      message: string;
      stdout?: string;
      stderr?: string;
    };

/**
 * A broker-infrastructure failure (child died, disconnected, or a request
 * timed out) — as opposed to a real command result (a non-zero exit or ENOENT,
 * which are reconstructed as ordinary errors). The `brokerInfra` flag lets the
 * session wrapper tell "the broker broke, retry directly" apart from "the
 * command genuinely failed, surface it" (see {@link isBrokerInfraError}).
 */
export class BrokerInfraError extends Error {
  readonly brokerInfra = true;
  constructor(message: string) {
    super(message);
    this.name = "BrokerInfraError";
  }
}

/** True when `error` is a broker-infrastructure failure, not a command error. */
export function isBrokerInfraError(error: unknown): boolean {
  return (error as { brokerInfra?: unknown } | null)?.brokerInfra === true;
}

export interface Broker {
  /** Run a command through the sidecar. Rejects with a real Error on failure. */
  readonly exec: ExecFn;
  /** False once the child has exited/errored or the broker was disposed. */
  readonly alive: boolean;
  /** The child pid, or undefined if the fork never produced one. */
  readonly pid: number | undefined;
  /** Kill the child and reject any in-flight requests. Idempotent. */
  dispose(): void;
}

export interface StartBrokerOptions {
  /**
   * Per-request timeout. Generous by default because a cold cargo build can
   * take minutes; a request that outlives this is treated as a broker-infra
   * failure so the caller can fall back to a direct spawn.
   */
  requestTimeoutMs?: number;
  /** Passed to the child as `VITE_RUST_BROKER_PPID_MS` (test seam). */
  ppidCheckMs?: number;
  /** Override the child entry path (tests point this at the `.ts` source). */
  childPath?: string;
}

/** 15 minutes: comfortably longer than any real cargo build. */
const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000;

/** Absolute path to the compiled sidecar entry, sibling of this module in dist. */
function defaultChildPath(): string {
  return fileURLToPath(new URL("./broker-child.js", import.meta.url));
}

interface Pending {
  resolve: (result: ExecResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Rebuild a real Error from an `ok:false` reply so downstream classification
 * (`isCommandNotFound`, `isTransientSpawnError`, cargo stderr tails) is
 * transparent — the error looks exactly like a direct `execFile` rejection. */
function reconstructError(reply: Extract<BrokerReply, { ok: false }>): Error {
  const error = new Error(reply.message) as Error & {
    code?: string | number;
    stdout?: string;
    stderr?: string;
  };
  if (reply.code !== undefined) error.code = reply.code;
  if (reply.stdout !== undefined) error.stdout = reply.stdout;
  if (reply.stderr !== undefined) error.stderr = reply.stderr;
  return error;
}

/**
 * Fork the sidecar and return a {@link Broker}, or `null` if the fork throws.
 * Never throws — a broker that cannot start must degrade to direct spawning,
 * not break the dev server.
 */
export function startBroker(options: StartBrokerOptions = {}): Broker | null {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const childPath = options.childPath ?? defaultChildPath();

  let child: ChildProcess;
  try {
    child = fork(childPath, [], {
      // No inherited stdio: the child only speaks over IPC, and a clean fd
      // table is the entire point — don't wire pipes we won't read.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // Don't inherit the parent's node flags — the sidecar needs none, and
      // inheriting e.g. `--test` (present when the unit suite forks the child)
      // would put it in the wrong mode.
      execArgv: [],
      env:
        options.ppidCheckMs !== undefined
          ? { ...process.env, VITE_RUST_BROKER_PPID_MS: String(options.ppidCheckMs) }
          : process.env,
    });
  } catch {
    return null;
  }

  let alive = true;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // Reject every in-flight request and mark the broker dead. Callers see a
  // distinguishable BrokerInfraError and fall back to direct spawning.
  const markDead = (reason: string): void => {
    if (!alive) return;
    alive = false;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new BrokerInfraError(reason));
    }
    pending.clear();
  };

  child.on("message", (reply: BrokerReply) => {
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve({ stdout: reply.stdout, stderr: reply.stderr });
    else entry.reject(reconstructError(reply));
  });
  child.on("exit", () => markDead("spawn broker exited before replying"));
  child.on("error", () => markDead("spawn broker process error"));

  const exec: ExecFn = (cmd, args, opts) => {
    if (!alive || !child.connected) {
      return Promise.reject(new BrokerInfraError("spawn broker is not available"));
    }
    return new Promise<ExecResult>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(
            new BrokerInfraError(
              `spawn broker request for \`${cmd}\` timed out after ` +
                `${requestTimeoutMs}ms`,
            ),
          );
        }
      }, requestTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, file: cmd, args, opts });
      } catch (err) {
        // send() can throw if the channel closed between the guard and here.
        pending.delete(id);
        clearTimeout(timer);
        reject(new BrokerInfraError(`spawn broker send failed: ${(err as Error).message}`));
      }
    });
  };

  const dispose = (): void => {
    markDead("spawn broker disposed");
    // disconnect closes the IPC channel → the child's `disconnect` handler
    // exits it; kill is the backstop if disconnect is a no-op.
    try {
      child.disconnect();
    } catch {
      // already disconnected
    }
    try {
      child.kill();
    } catch {
      // already gone
    }
  };

  return {
    exec,
    get alive() {
      return alive;
    },
    get pid() {
      return child.pid;
    },
    dispose,
  };
}

/**
 * Compose a session {@link ExecFn}: run through the broker while it is alive,
 * and on a broker-infrastructure failure (died / timed out) fall back to a
 * direct spawn exactly once. Real command errors (ENOENT, non-zero exits) are
 * re-thrown untouched so the caller's existing classification handles them.
 * With `broker === null` this is just `direct`, i.e. current behavior.
 */
export function makeSessionExec(broker: Broker | null, direct: ExecFn): ExecFn {
  if (broker === null) return direct;
  return async (cmd, args, opts) => {
    if (!broker.alive) return direct(cmd, args, opts);
    try {
      return await broker.exec(cmd, args, opts);
    } catch (error: unknown) {
      if (isBrokerInfraError(error)) return direct(cmd, args, opts);
      throw error;
    }
  };
}
