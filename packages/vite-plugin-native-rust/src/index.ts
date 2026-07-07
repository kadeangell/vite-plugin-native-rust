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
import { findCargoToml } from "./crate.ts";
import { ensureAddonsBesideChunks, type EmittedAddon } from "./output.ts";
import { resolveOptions, type RustPluginOptions } from "./options.ts";
import {
  ensureCrateCompiled,
  prewarmCrates,
  recordCrateInManifest,
} from "./prewarm.ts";
import { isVitest, shouldBypassSsrGate, shouldUseDevShape } from "./vitest.ts";

export type { RustPluginOptions } from "./options.ts";
export { rustTestStub } from "./stub.ts";

const RUST_QUERY = "?rust";
const DEFAULT_CACHE_SUBDIR = join("node_modules", ".cache", "vite-rust");

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

  const cacheBaseDir = (): string => {
    if (!opts.cacheDir) return join(root, DEFAULT_CACHE_SUBDIR);
    return isAbsolute(opts.cacheDir) ? opts.cacheDir : resolve(root, opts.cacheDir);
  };

  return {
    name: "vite-rust",
    enforce: "pre",

    config() {
      // The native `.node` is emitted as an asset into the SSR bundle, but Vite
      // drops SSR-build assets unless `ssrEmitAssets` is set — so a bare
      // `vite build --ssr` would ship a server that can't find its addon.
      // Frameworks (React Router) wire this up themselves; we guarantee it for
      // everyone. User config still wins if they set it explicitly.
      return { build: { ssrEmitAssets: true } };
    },

    configResolved(config) {
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
    configureServer() {
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
  };
}

export default rustPlugin;
