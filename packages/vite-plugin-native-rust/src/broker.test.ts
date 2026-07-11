import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  type Broker,
  BrokerInfraError,
  isBrokerInfraError,
  makeSessionExec,
  startBroker,
} from "./broker.ts";
import { isCommandNotFound } from "./spawn.ts";

const node = process.execPath;
// Fork the `.ts` source directly (the test process already runs under node's
// type stripping); production forks the compiled `dist/broker-child.js`.
const childPath = fileURLToPath(new URL("./broker-child.ts", import.meta.url));
const fdHostPath = fileURLToPath(new URL("./broker-fd-host.ts", import.meta.url));
const orphanHostPath = fileURLToPath(
  new URL("./broker-orphan-host.ts", import.meta.url),
);

/** Track brokers so a failed assertion can never leak a child process. */
const brokers: Broker[] = [];
function open(options?: Parameters<typeof startBroker>[0]): Broker {
  const broker = startBroker({ childPath, ...options });
  assert.ok(broker, "startBroker returned null");
  brokers.push(broker);
  return broker;
}
after(() => {
  for (const broker of brokers) broker.dispose();
});

/** Poll `process.kill(pid, 0)` until the process is gone or `timeoutMs` passes. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — gone
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("protocol round-trip: stdout and stderr survive intact", async () => {
  const broker = open();
  const { stdout, stderr } = await broker.exec(node, [
    "-e",
    "process.stdout.write('OUT');process.stderr.write('ERR')",
  ]);
  assert.equal(stdout, "OUT");
  assert.equal(stderr, "ERR");
});

test("protocol round-trip: ENOENT code survives (isCommandNotFound still works)", async () => {
  const broker = open();
  await assert.rejects(
    broker.exec("vite-rust-no-such-binary-xyz", []),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ENOENT");
      assert.equal(isCommandNotFound(error), true);
      return true;
    },
  );
});

test("protocol round-trip: non-zero exit preserves numeric code + stderr tail", async () => {
  const broker = open();
  await assert.rejects(
    broker.exec(node, [
      "-e",
      "process.stderr.write('boom-detail');process.exit(3)",
    ]),
    (error: NodeJS.ErrnoException & { stderr?: string; stdout?: string }) => {
      assert.equal(error.code, 3);
      assert.match(error.stderr ?? "", /boom-detail/);
      assert.equal(typeof error.stdout, "string");
      // A numeric exit code is NOT a command-not-found.
      assert.equal(isCommandNotFound(error), false);
      return true;
    },
  );
});

test("per-request timeout rejects with a broker-infra error", async () => {
  const broker = open({ requestTimeoutMs: 150 });
  await assert.rejects(
    // Self-exits after 3s so no orphan lingers past the test; the 150ms
    // timeout fires first.
    broker.exec(node, ["-e", "setTimeout(()=>process.exit(0),3000)"]),
    (error: unknown) => {
      assert.equal(isBrokerInfraError(error), true);
      assert.ok(error instanceof BrokerInfraError);
      return true;
    },
  );
});

test("broker death mid-request rejects in-flight with a distinguishable error", async () => {
  const broker = open();
  const pid = broker.pid;
  assert.ok(pid);
  const inflight = broker.exec(node, ["-e", "setTimeout(()=>process.exit(0),3000)"]);
  // Give the request a beat to reach the child, then kill the child.
  await new Promise((r) => setTimeout(r, 100));
  process.kill(pid, "SIGKILL");
  await assert.rejects(inflight, (error: unknown) => {
    assert.equal(isBrokerInfraError(error), true);
    return true;
  });
  assert.equal(broker.alive, false);
});

test("exec after death rejects with a broker-infra error", async () => {
  const broker = open();
  const pid = broker.pid;
  assert.ok(pid);
  process.kill(pid, "SIGKILL");
  assert.ok(await waitForExit(pid, 2000), "child did not exit after SIGKILL");
  // The 'exit' handler flips alive=false; give it a tick to fire.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(broker.alive, false);
  await assert.rejects(broker.exec(node, ["--version"]), (error: unknown) => {
    assert.equal(isBrokerInfraError(error), true);
    return true;
  });
});

test("dispose kills the child process", async () => {
  const broker = startBroker({ childPath });
  assert.ok(broker);
  const pid = broker.pid;
  assert.ok(pid);
  broker.dispose();
  assert.equal(broker.alive, false);
  assert.ok(await waitForExit(pid, 3000), "child still alive after dispose");
});

test("makeSessionExec(null, direct) is exactly the direct exec", () => {
  const direct = async () => ({ stdout: "d", stderr: "" });
  assert.equal(makeSessionExec(null, direct), direct);
});

test("makeSessionExec passes real command errors through without falling back", async () => {
  // Default (long) timeout so a fast non-zero exit always gets a real reply,
  // never a spurious timeout — this leg must be deterministic under load.
  const broker = open();
  let directCalls = 0;
  const direct = async () => {
    directCalls += 1;
    return { stdout: "fallback", stderr: "" };
  };
  const session = makeSessionExec(broker, direct);
  await assert.rejects(
    session(node, ["-e", "process.exit(7)"]),
    (error: Error & { code?: string | number }) => error.code === 7,
  );
  assert.equal(directCalls, 0, "real command errors must not trigger fallback");
});

test("makeSessionExec falls back to direct exactly once on a broker-infra failure", async () => {
  // A 50ms timeout against a 3s sleep guarantees the timeout fires first
  // (regardless of machine load), producing a broker-infra failure → fallback.
  const broker = open({ requestTimeoutMs: 50 });
  let directCalls = 0;
  const direct = async () => {
    directCalls += 1;
    return { stdout: "fallback", stderr: "" };
  };
  const session = makeSessionExec(broker, direct);
  const result = await session(node, ["-e", "setTimeout(()=>process.exit(0),3000)"]);
  assert.equal(result.stdout, "fallback");
  assert.equal(directCalls, 1);
});

test("parent death: the orphaned broker exits on its own", async () => {
  const out = execFileSync(
    node,
    ["-e", `const{spawn}=require('node:child_process');
      const c=spawn(process.execPath,[${JSON.stringify(orphanHostPath)}],
        {stdio:['ignore','pipe','ignore'],
         env:{...process.env,BROKER_CHILD_PATH:${JSON.stringify(childPath)},BROKER_PPID_MS:'200'}});
      let buf='';
      c.stdout.on('data',d=>{buf+=d;const m=buf.match(/__PID__(\\d+)/);
        if(m){process.stdout.write(m[1]);c.kill('SIGKILL');process.exit(0);}});
      setTimeout(()=>{process.stderr.write('no pid');process.exit(1)},8000);`],
    { encoding: "utf8" },
  );
  const brokerPid = Number(out.trim());
  assert.ok(Number.isInteger(brokerPid) && brokerPid > 0, `bad pid: ${out}`);
  // disconnect (parent death closed IPC) or the 200ms ppid poll must reap it.
  assert.ok(
    await waitForExit(brokerPid, 5000),
    "orphaned broker did not exit after parent death",
  );
});

test("KILLER: broker compiles through 24,500 held fds where direct spawn dies", () => {
  // Run the poisoning in a throwaway process under a raised fd limit, so the
  // test runner itself is never poisoned. `$0`/`$1`/`$2` avoid quoting issues.
  const raw = execFileSync(
    "sh",
    ["-c", 'ulimit -n 30000; exec "$1" "$2"', "sh", node, fdHostPath],
    {
      encoding: "utf8",
      env: { ...process.env, BROKER_CHILD_PATH: childPath },
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const line = raw.split("\n").find((l) => l.startsWith("__RESULT__"));
  assert.ok(line, `no result line from fd host. Output:\n${raw}`);
  const result = JSON.parse(line.slice("__RESULT__".length)) as {
    heldFds: number;
    reachedThreshold: boolean;
    cmd: string;
    brokered: { ok: boolean; code?: string | number; stdout?: string };
    direct: { ok: boolean; code?: string | number };
  };

  // The product guarantee: a spawn through the broker succeeds even with a
  // poisoned host fd table.
  assert.equal(
    result.brokered.ok,
    true,
    `brokered exec failed: ${JSON.stringify(result.brokered)}`,
  );

  if (!result.reachedThreshold) {
    // The environment's fd ceiling is below the ~24k EBADF cliff (rare CI
    // sandbox), so the poisoning can't be reproduced — nothing more to assert.
    return;
  }

  // Proof the test is real: the *same* direct spawn, in that same poisoned
  // process, dies with EBADF. This is macOS-specific (Linux tolerates a large
  // fd table), so only assert it there.
  if (process.platform === "darwin") {
    assert.equal(
      result.direct.ok,
      false,
      "direct spawn unexpectedly succeeded under 24.5k fds — poisoning not real",
    );
    assert.equal(result.direct.code, "EBADF");
  }
});
