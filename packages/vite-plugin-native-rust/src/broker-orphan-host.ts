/**
 * Parent-death-cleanup host for the spawn broker (issue #8) — NOT a test file,
 * and not a build entry. `broker.test.ts` spawns this, reads the broker child's
 * pid from stdout, then SIGKILLs this process and asserts the orphaned broker
 * exits on its own (via the IPC `disconnect` and the ppid safety net).
 *
 * A short `VITE_RUST_BROKER_PPID_MS` (from `BROKER_PPID_MS`) keeps the backup
 * poll fast enough for a test. The child entry path comes from
 * `BROKER_CHILD_PATH`.
 */
import { startBroker } from "./broker.ts";

const childPath = process.env.BROKER_CHILD_PATH;
const ppidCheckMs = Number(process.env.BROKER_PPID_MS ?? "200");

const broker = startBroker({
  ...(childPath ? { childPath } : {}),
  ppidCheckMs,
});

if (!broker || broker.pid === undefined) {
  process.stdout.write("__PID__none\n");
  process.exit(1);
}

process.stdout.write(`__PID__${broker.pid}\n`);

// Hang forever holding the broker open; the parent will kill us. Deliberately
// NOT calling dispose — the whole point is proving the child cleans itself up
// when the parent dies abruptly.
setInterval(() => {}, 1_000);
