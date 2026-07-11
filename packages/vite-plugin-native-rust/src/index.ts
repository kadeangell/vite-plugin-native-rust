import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Plugin } from "vite";

import {
  type AddonExport,
  buildModuleSource,
  devModuleSource,
  enumerateExports,
  ensureTsconfigOption,
  syncTypeDeclaration,
} from "./codegen.ts";
import { type Broker, makeSessionExec, startBroker } from "./broker.ts";
import { anchorToRoot, findCargoToml } from "./crate.ts";
import { ensureAddonsBesideChunks, type EmittedAddon } from "./output.ts";
import { resolveOptions, type RustPluginOptions } from "./options.ts";
import {
  ensureCrateCompiled,
  knownCrateDirs,
  prewarmCrates,
  recordCrateInManifest,
} from "./prewarm.ts";
import { directExec, type ExecFn, processFdCount } from "./spawn.ts";
import { isVitest, shouldBypassSsrGate, shouldUseDevShape } from "./vitest.ts";

export type { RustPluginOptions } from "./options.ts";
export { rustTestStub } from "./stub.ts";

const RUST_QUERY = "?rust";
const DEFAULT_CACHE_SUBDIR = join("node_modules", ".cache", "vite-rust");

// Process-wide spawn broker (issue #8). Frameworks such as React Router
// construct more than one plugin instance in a single dev process (one per
// Vite environment — client + SSR), each of which runs the `config` hook; a
// per-process singleton keeps that to a single sidecar. It is the natural
// model anyway — the broker is shared spawn infrastructure, not per-instance
// state. The `alive` re-check lets a dev-server restart (Vite disposes and
// re-creates plugins in the same process) start a fresh broker after the old
// one was torn down.
let processBroker: Broker | null = null;

function ensureProcessBroker(): Broker | null {
  if (processBroker !== null && processBroker.alive) return processBroker;
  processBroker = startBroker();
  return processBroker;
}

function disposeProcessBroker(): void {
  if (processBroker === null) return;
  processBroker.dispose();
  processBroker = null;
}

interface LoadOptions {
  ssr?: boolean;
}

/**
 * Vite plugin that lets server-only modules `import { fn } from "./crate/src/lib.rs"`.
 * It compiles the enclosing Cargo crate into a native `.node` addon (via
 * `@napi-rs/cli`), content-hash caches it, and generates named-export JS that
 * loads the binary at runtime. Server-side only — see the `options.ssr` gate.
 */
export function rustPlugin(options?: RustPluginOptions): Plugin {
  const opts = resolveOptions(options);
  let root = process.cwd();
  // Set in `configResolved`: the plugin is running inside a vitest pipeline, so
  // the client-graph gate and build-shape codegen are both wrong here (tests run
  // in Node; no bundle is written). See ./vitest.ts and docs/testing.md.
  let underVitest = false;

  // Every `.node` this plugin emitted during the build, keyed by the asset
  // fileName. `writeBundle` uses these to guarantee each addon survives next to
  // the chunks that reference it (issue #1).
  const emittedAddons = new Map<string, EmittedAddon>();

  // Spawn broker (issue #8): a helper process forked at dev init, while the
  // host fd table is still small, that runs every cargo/napi spawn with a clean
  // fd table — so compiles survive a poisoned host (issue #6). Acquired from a
  // per-process singleton in the `config` hook for dev only (see below);
  // `sessionExec` routes through it when alive and falls back to a direct spawn
  // otherwise. In build mode / under vitest the broker is never started and
  // `sessionExec` stays direct.
  let sessionExec: ExecFn = directExec;
  const disposeBroker = (): void => {
    disposeProcessBroker();
    sessionExec = directExec;
  };

  // Optional fd-count instrumentation (VITE_RUST_BROKER_DEBUG): reveals how the
  // host fd table grows across the dev lifecycle, justifying why the broker
  // starts at `config` (earliest, smallest table) rather than after the watcher
  // attaches. No-op unless the env var is set.
  const fdDebug = (hook: string): void => {
    if (!process.env.VITE_RUST_BROKER_DEBUG) return;
    process.stderr.write(`[vite-rust] fd-count @ ${hook}: ${processFdCount()}\n`);
  };

  const cacheBaseDir = (): string => {
    if (!opts.cacheDir) return join(root, DEFAULT_CACHE_SUBDIR);
    return isAbsolute(opts.cacheDir) ? opts.cacheDir : resolve(root, opts.cacheDir);
  };

  // Dev server handle + the crate dirs whose target/ we've already unwatched.
  // Crates discovered at load time (not in the manifest at config time) get
  // their target/ pulled out of the watcher here — same fd-exhaustion defense
  // as the config-time ignore (issue #6).
  let devWatcher: { unwatch: (paths: string | string[]) => unknown } | null = null;
  const unwatchedTargets = new Set<string>();
  const unwatchCrateTarget = (crateDir: string): void => {
    if (!devWatcher || unwatchedTargets.has(crateDir)) return;
    unwatchedTargets.add(crateDir);
    try {
      const target = join(crateDir, "target");
      devWatcher.unwatch([target, join(target, "**")]);
    } catch {
      // Watcher differences across Vite majors — never let hygiene break dev.
    }
  };

  return {
    name: "vite-rust",
    enforce: "pre",

    config(userConfig, env) {
      fdDebug("config");
      // Start the spawn broker as early as possible (issue #8): this hook runs
      // before Vite creates the dev watcher, so the host's fd table is at its
      // smallest and the forked child inherits a clean one. Dev only — a build
      // is short-lived and watcher-free (`env.command === "build"`), so direct
      // spawning stays. Skipped under vitest (tests spawn on demand in-process)
      // and when the option is off. Never throws: `startBroker` returns null on
      // failure and `sessionExec` stays direct.
      //
      // `ensureProcessBroker` dedups across plugin instances (React Router
      // resolves config once per Vite environment), so this forks at most one
      // sidecar per dev process.
      if (opts.spawnBroker && env?.command === "serve" && !isVitest(userConfig)) {
        sessionExec = makeSessionExec(ensureProcessBroker(), directExec);
      }

      // Two guarantees (user config always wins where it conflicts):
      // 1. `ssrEmitAssets` — Vite drops SSR-build assets otherwise, so a bare
      //    `vite build --ssr` would ship a server that can't find its addon.
      // 2. Watch-ignore every known crate's `target/` (issue #6 forensics): a
      //    crate living inside the watched root feeds thousands of cargo
      //    intermediate files to the dev watcher, which holds an fd per file —
      //    a bloated fd table eventually breaks child-process spawning with
      //    EBADF. Crates are known here via the pre-warm manifest and explicit
      //    `prewarm` anchors; crates first discovered at load time are
      //    unwatched at runtime instead (see `load`).
      const cwd = (userConfig.root as string | undefined) ?? process.cwd();
      const cacheBase = !opts.cacheDir
        ? join(cwd, DEFAULT_CACHE_SUBDIR)
        : isAbsolute(opts.cacheDir)
          ? opts.cacheDir
          : resolve(cwd, opts.cacheDir);
      const ignored = knownCrateDirs(cacheBase, cwd, opts.prewarm).map(
        (dir) => join(dir, "target", "**"),
      );
      return {
        build: { ssrEmitAssets: true },
        ...(ignored.length > 0 ? { server: { watch: { ignored } } } : {}),
      };
    },

    configResolved(config) {
      fdDebug("configResolved");
      root = config.root;
      underVitest = isVitest(config);
      // Skip tsconfig mutation under vitest: it's an editor/typecheck concern,
      // irrelevant to running tests, and writing during a test run risks
      // watch-mode churn and races between per-project plugin instances.
      if (opts.emitTypes && !underVitest) ensureTsconfigOption(root);
    },

    // Dev-only pre-warm (issue #5): start cold cargo compiles at server
    // startup so they race the developer's first request instead of blocking
    // inside it (Nitro's module-runner invoke timeout is 60s → 500, and the
    // failed module fetch stays cached until restart). Fire-and-forget: it
    // must never delay startup or crash the server — `prewarmCrates` reports
    // per-crate failures as warnings and never rejects. Skipped under vitest
    // (tests compile on demand); build mode never calls this hook.
    configureServer(server) {
      fdDebug("configureServer");
      devWatcher = server.watcher;
      // Tear the broker down promptly when the dev server closes. Vite's
      // shutdown path across versions is inconsistent about calling the Rollup
      // `closeBundle`/`buildEnd` hooks for a dev server, so hook the underlying
      // http server's `close` here too; all dispose paths are idempotent, and
      // the child's own ppid check is the ultimate safety net regardless.
      server.httpServer?.once("close", disposeBroker);
      if (underVitest || opts.prewarm === false) return;
      const write = (message: string): void => {
        process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
      };
      void prewarmCrates({
        root,
        cacheBase: cacheBaseDir(),
        opts,
        onLog: write,
        onWarn: write,
        exec: sessionExec,
      }).catch((err: unknown) => {
        // Belt and suspenders — prewarmCrates itself never rejects.
        write(`[vite-rust] pre-warm failed: ${(err as Error).message}`);
      });
    },

    resolveId(source, importer) {
      const cleanSource = source.split("?")[0];
      if (!cleanSource.endsWith(".rs")) return null;

      const isRelative =
        cleanSource.startsWith("./") || cleanSource.startsWith("../");
      const isAbs = isAbsolute(cleanSource);
      // Never claim bare package specifiers like `some-pkg/foo.rs`.
      if (!isRelative && !isAbs) return null;

      let absPath: string;
      if (isAbs) {
        absPath = cleanSource;
      } else {
        if (!importer) return null;
        const importerDir = dirname(importer.split("?")[0]);
        absPath = resolve(importerDir, cleanSource);
      }
      // rolldown-vite (Vite 8) can pass PROJECT-ROOT-RELATIVE importer ids
      // ("/app/…" instead of a real filesystem path), which makes `absPath`
      // fake-absolute: the crate walk in `load` then climbs the real
      // filesystem from a directory that doesn't exist (issue #7). When the
      // resolved path isn't on disk but re-anchoring it under config.root is,
      // use the re-anchored path.
      absPath = anchorToRoot(absPath, root);
      // Claim unconditionally — the SSR decision belongs in `load`.
      return `${absPath}${RUST_QUERY}`;
    },

    async load(id, loadOptions: LoadOptions | undefined) {
      if (!id.endsWith(`.rs${RUST_QUERY}`)) return null;

      // Client gate (load-bearing): a non-server module importing this `.rs`
      // would leak it toward the client graph, where `options.ssr` is false.
      // Bypassed under vitest — tests run in Node (jsdom/happy-dom only emulate
      // the DOM in-process), so the gate would reject legitimate test imports
      // (vitest reports ssr=false for web-style environments) while protecting
      // nothing. See ./vitest.ts.
      if (!shouldBypassSsrGate(underVitest, loadOptions?.ssr)) {
        return this.error(
          "Rust modules can only be imported server-side — import this only " +
            "from a .server.ts module (or another server-only module), never " +
            "from code that can reach the client bundle.",
        );
      }

      const rsPath = id.slice(0, -RUST_QUERY.length);

      const crateDir = findCargoToml(rsPath);
      if (crateDir) unwatchCrateTarget(crateDir);
      if (!crateDir) {
        return this.error(
          `No Cargo.toml found for Rust import "${rsPath}". Walked up from ` +
            `"${dirname(rsPath)}" to the filesystem root without finding one. ` +
            "A .rs import must live inside a Cargo crate (a directory with a " +
            "Cargo.toml).",
        );
      }

      // The shared compile-through-cache pipeline — the same one the dev
      // pre-warm runs, so a load arriving mid-pre-warm coalesces onto the
      // in-flight compile (same inputs → same cachePath → same dedupe key)
      // instead of racing a second cargo process. Under vitest the profile
      // default is debug (fast compile), matching dev — a machine that built
      // the crate once reuses that cached debug binary at zero compile cost.
      let cachePath: string;
      let binaryName: string;
      let hash: string;
      try {
        const compiled = await ensureCrateCompiled({
          crateDir,
          cacheBase: cacheBaseDir(),
          opts,
          watchMode: this.meta.watchMode === true,
          underVitest,
          onWarn: (message) => this.warn(message),
          exec: sessionExec,
        });
        ({ cachePath, binaryName, hash } = compiled);
        // Full local dependency closure: fold every file into the watch set so
        // a sibling path-dep or lockfile change recompiles.
        for (const input of compiled.inputs) this.addWatchFile(input);
      } catch (err) {
        return this.error((err as Error).message);
      }

      // Remember the crate for next session's dev pre-warm (issue #5). Skipped
      // under vitest: test-fixture crates must not leak into dev pre-warms,
      // and mid-test-run writes risk watch churn.
      if (!underVitest && opts.prewarm !== false) {
        recordCrateInManifest(cacheBaseDir(), crateDir, (m) => this.warn(m));
      }

      let keys: AddonExport[];
      try {
        keys = enumerateExports(cachePath);
      } catch (err) {
        return this.error(
          `Built the addon but failed to load "${cachePath}" to enumerate its ` +
            `exports: ${(err as Error).message}`,
        );
      }

      // Types (PLAN step 7): mirror napi's generated `.d.ts` next to the `.rs`.
      // Prefer the hash-versioned copy so a cache hit syncs the .d.ts that
      // matches the cached binary, not whatever revision compiled last. Skipped
      // under vitest — writing a `.d.rs.ts` mid-test-run only risks watch churn
      // and cross-project races; type declarations are a dev/editor concern.
      if (opts.emitTypes && !underVitest) {
        const versionedDts = `${cachePath}.d.ts`;
        const generatedDts = existsSync(versionedDts)
          ? versionedDts
          : join(crateDir, "index.d.ts");
        const anchorDts = rsPath.replace(/\.rs$/, ".d.rs.ts");
        const wroteDts = syncTypeDeclaration(generatedDts, anchorDts);
        if (wroteDts && opts.logLevel !== "silent") {
          this.info(`[vite-rust] wrote types → ${wroteDts}`);
        }
      }

      // Dev shape (require from the absolute cache path) in Rollup watch mode
      // and always under vitest: vitest never writes a bundle, so the
      // build-shape ROLLUP_FILE_URL token would resolve to nothing.
      if (shouldUseDevShape(underVitest, this.meta.watchMode === true)) {
        return devModuleSource(cachePath, keys);
      }

      const fileName = `${binaryName}-${hash}.node`;
      const refId = this.emitFile({
        type: "asset",
        fileName,
        source: readFileSync(cachePath),
      });
      emittedAddons.set(fileName, { fileName, cachePath });
      return buildModuleSource(refId, keys);
    },

    // Safety net for post-processing that carries chunk code without the
    // sibling asset (e.g. the @vercel/react-router preset's per-function
    // repackaging): after the bundle is written, ensure every emitted `.node`
    // exists next to each chunk that references it, copying from the compile
    // cache when it doesn't — or failing loudly when it can't (issue #1).
    writeBundle(outputOptions, bundle) {
      if (emittedAddons.size === 0) return;
      const outDir = outputOptions.dir;
      if (!outDir) return;

      const placements = ensureAddonsBesideChunks(
        outDir,
        bundle as Record<string, { type: string; fileName: string; code?: string }>,
        [...emittedAddons.values()],
      );
      if (placements.length > 0 && opts.logLevel !== "silent") {
        for (const p of placements) {
          this.warn(
            `[vite-rust] recovered dropped addon "${p.addon}" → "${p.to}" ` +
              `(referenced by "${p.chunk}" but missing from the written output)`,
          );
        }
      }
    },

    // Dispose the broker when Vite closes the plugin container. Vite calls
    // these on dev-server shutdown in most versions (and always at build end,
    // where the broker is null anyway); combined with the http-server `close`
    // hook above and the child's ppid check, the sidecar never outlives the
    // host. Idempotent — safe to fire more than once.
    buildEnd() {
      disposeBroker();
    },
    closeBundle() {
      disposeBroker();
    },
  };
}

export default rustPlugin;
