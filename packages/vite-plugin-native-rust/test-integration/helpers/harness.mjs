// Shared harness for the integration suite: dynamic ports, child-process
// lifecycle (spawned in their own process group so the whole tree dies on
// kill), stream capture, and cache-dir bookkeeping. No test logic lives here —
// each *.test.mjs composes these primitives.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Absolute path to a package's CLI entry, resolved from `fromDir` so the
 * fixture's own (possibly nested) copy is used. `binName` defaults to the
 * package name.
 */
export function resolveBin(fromDir, pkgName, binName = pkgName) {
  const require = createRequire(join(fromDir, "noop.js"));
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!rel) throw new Error(`no "${binName}" bin in ${pkgName}`);
  return join(dirname(pkgJsonPath), rel);
}

/** A never-reused TCP port: bind :0, read the assigned port, release it. */
export async function getFreePort() {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** Fresh empty cache dir under the OS tmp root; caller cleans up via cleanup(). */
export function freshCacheDir(tag = "vite-rust-it") {
  return mkdtempSync(join(tmpdir(), `${tag}-`));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Absolute paths of every `*.node` file directly inside `dir` (empty if none). */
export function nodeFilesIn(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".node"))
    .map((e) => join(dir, e.name));
}

/** Recursive count of `*.node` files under `dir` (for build-output assertions). */
export function countNodeFilesRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) total += countNodeFilesRecursive(full);
    else if (e.isFile() && e.name.endsWith(".node")) total += 1;
  }
  return total;
}

const COMPILE_LINE = /\[vite-rust\] compiling crate/g;

/** How many times the plugin announced a fresh compile in captured output. */
export function compileCount(text) {
  return (text.match(COMPILE_LINE) ?? []).length;
}

/**
 * Spawn a command in its own process group (`detached`) with piped stdio,
 * accumulating stdout/stderr into `.output`. Returns a handle exposing the
 * live buffers plus `waitReady`, `waitExit`, and a group-wide `kill`.
 */
export function launch(cmd, args, { cwd, env } = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle = {
    child,
    stdout: "",
    stderr: "",
    get output() {
      return this.stdout + this.stderr;
    },
  };
  child.stdout.on("data", (d) => (handle.stdout += d.toString()));
  child.stderr.on("data", (d) => (handle.stderr += d.toString()));

  /** Resolve once `pattern` shows up in combined output, else reject on timeout/exit. */
  handle.waitReady = (pattern, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${pattern}\n--- output ---\n${handle.output}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (pattern.test(handle.output)) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(
          new Error(
            `process exited (code ${code}) before ready\n--- output ---\n${handle.output}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", check);
        child.stderr.off("data", check);
        child.off("exit", onExit);
      };
      child.stdout.on("data", check);
      child.stderr.on("data", check);
      child.on("exit", onExit);
      check();
    });

  handle.waitExit = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.on("exit", (code) => resolve(code ?? 0));
    });

  handle.kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* group already gone */
    }
    const exited = await Promise.race([
      handle.waitExit(),
      new Promise((r) => setTimeout(() => r("timeout"), 5_000)),
    ]);
    if (exited === "timeout") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  };

  return handle;
}

/** Run a command to completion, returning `{ code, stdout, stderr, output }`. */
export async function run(cmd, args, opts = {}) {
  const handle = launch(cmd, args, opts);
  const code = await handle.waitExit();
  return { code, stdout: handle.stdout, stderr: handle.stderr, output: handle.output };
}

/** GET `url` and return the response body as text (throws on non-2xx). */
export async function fetchText(url) {
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}\n${body}`);
  }
  return body;
}

/**
 * GET with retry — dev/serve processes print "ready" a beat before the socket
 * actually accepts connections. Retries on connection errors and non-2xx.
 */
export async function fetchTextRetry(url, { attempts = 30, delayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchText(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
