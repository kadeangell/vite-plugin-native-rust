/**
 * Spawn-broker sidecar (issue #8) — the child half.
 *
 * A fd-bloated dev-server process can no longer spawn subprocesses: past
 * ≈24k open file descriptors, macOS/Node child-process spawning fails with
 * `spawn EBADF` for *every* subprocess (issue #6, clean-room proven). This
 * process is forked at plugin init while the host's fd table is still small,
 * so its own table stays clean and it can run cargo forever no matter how
 * poisoned the host becomes.
 *
 * It listens on the fork IPC channel for exec requests, runs them with the
 * ordinary `execFile`, and replies with full fidelity: `code` (ENOENT string
 * or a numeric exit code), `stdout`, `stderr`, and `message` all survive the
 * round trip so the host's error classification (`isCommandNotFound`,
 * `isTransientSpawnError`, the cargo stderr tails) works transparently through
 * the broker. No dependencies beyond node builtins — it must start even when
 * the host is barely functional.
 *
 * This file is compiled by tsup as its own entry (`dist/broker-child.js`) and
 * resolved by absolute path from the host; it is intentionally NOT a package
 * export.
 */
import { execFile } from "node:child_process";

/** A request from the host: run `file args` and reply keyed by `id`. */
interface BrokerRequest {
  id: number;
  file: string;
  args: string[];
  opts?: { cwd?: string; maxBuffer?: number };
}

/** A reply back to the host, keyed by the request `id`. */
type BrokerReply =
  | { id: number; ok: true; stdout: string; stderr: string }
  | {
      id: number;
      ok: false;
      /** ENOENT etc. (string) or a numeric process exit code. */
      code?: string | number;
      message: string;
      stdout?: string;
      stderr?: string;
    };

/**
 * How often to check whether the host is gone. `disconnect` handles the normal
 * case (parent death closes the IPC channel); this ppid poll is belt-and-
 * suspenders for the rare case where the channel does not close cleanly — once
 * the parent is reaped, `process.ppid` becomes 1 (adopted by init/launchd).
 * Overridable via env so the parent-death test need not wait 30s.
 */
const DEFAULT_PPID_CHECK_MS = 30_000;

function ppidCheckMs(): number {
  const raw = process.env.VITE_RUST_BROKER_PPID_MS;
  if (raw === undefined) return DEFAULT_PPID_CHECK_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PPID_CHECK_MS;
}

function reply(message: BrokerReply): void {
  // `process.send` is defined because we were forked with an IPC channel; the
  // guard keeps TypeScript honest and no-ops if the channel already closed.
  process.send?.(message);
}

function handleRequest(request: BrokerRequest): void {
  const { id, file, args, opts } = request;
  execFile(
    file,
    args,
    { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer },
    (error, stdout, stderr) => {
      if (error) {
        // execFile attaches the captured output to the callback args (not the
        // error) and puts ENOENT / the numeric exit code on `error.code`.
        const err = error as NodeJS.ErrnoException & {
          code?: string | number;
        };
        reply({
          id,
          ok: false,
          code: err.code,
          message: err.message,
          stdout: String(stdout),
          stderr: String(stderr),
        });
        return;
      }
      reply({ id, ok: true, stdout: String(stdout), stderr: String(stderr) });
    },
  );
}

process.on("message", (message: BrokerRequest) => {
  // Ignore anything that is not a well-formed request rather than crashing —
  // the host owns the protocol, but a hostile/garbled message must not take
  // down the broker mid-session.
  if (
    typeof message?.id === "number" &&
    typeof message?.file === "string" &&
    Array.isArray(message?.args)
  ) {
    handleRequest(message);
  }
});

// Parent death closes the IPC channel → exit. This is the primary shutdown
// path; without it the broker would leak as an orphan for one ppid interval.
process.on("disconnect", () => process.exit(0));

// Belt-and-suspenders: if the channel somehow stays open after the parent is
// reaped, `ppid === 1` means we were re-parented to init/launchd → exit. The
// timer is unref'd so it never keeps the process alive on its own; the live
// IPC channel is what holds it open while the host is present.
const ppidTimer = setInterval(() => {
  if (process.ppid === 1) process.exit(0);
}, ppidCheckMs());
ppidTimer.unref();
