import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Plugin } from "vite";

import { collectClosureInputs } from "./closure.ts";
import {
  assertCargoAvailable,
  compileCrate,
  ensureCrateBinaryName,
  resolveNapiBin,
} from "./compile.ts";
import {
  type AddonExport,
  buildModuleSource,
  devModuleSource,
  enumerateExports,
  ensureTsconfigOption,
  syncTypeDeclaration,
} from "./codegen.ts";
import { findCargoToml, hashInputs } from "./crate.ts";
import { dedupeInFlight } from "./dedupe.ts";
import { ensureAddonsBesideChunks, type EmittedAddon } from "./output.ts";
import { resolveOptions, type RustPluginOptions } from "./options.ts";
import {
  isVitest,
  resolveRelease,
  shouldBypassSsrGate,
  shouldUseDevShape,
} from "./vitest.ts";
import { getToolchainKey, toolchainKeyString } from "./toolchain.ts";

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

      let binaryName: string;
      try {
        const config = ensureCrateBinaryName(crateDir, opts.generateCratePackageJson);
        binaryName = config.binaryName;
        if (config.generatedMessage) this.warn(config.generatedMessage);
      } catch (err) {
        return this.error((err as Error).message);
      }

      // Full local dependency closure (crate + path/workspace deps + workspace
      // Cargo.toml + lockfile): fold every file into both the watch set and the
      // cache hash so a sibling path-dep or lockfile change recompiles.
      const inputs = await collectClosureInputs(crateDir, {
        onWarn: (message) => this.warn(message),
      });
      for (const input of inputs) this.addWatchFile(input);

      // Toolchain fingerprint in the key: a rustc / napi-cli upgrade invalidates
      // even byte-identical sources. Resolve the CLI defensively so computing the
      // key never hard-fails before the actual compile step.
      let napiBin: string | null = null;
      try {
        napiBin = resolveNapiBin();
      } catch {
        napiBin = null;
      }
      const toolchain = toolchainKeyString(await getToolchainKey(napiBin));

      let hash: string;
      try {
        hash = hashInputs(crateDir, inputs, toolchain);
      } catch (err) {
        return this.error((err as Error).message);
      }

      // Both profiles overwrite the same napi output path, so the profile is
      // part of the cache key and filename. Under vitest the default is debug
      // (fast compile), matching dev — a machine that built the crate once
      // reuses that cached debug binary at zero compile cost.
      const release = resolveRelease(
        opts.profile,
        this.meta.watchMode === true,
        underVitest,
      );
      const profile = release ? "release" : "debug";
      const cachePath = join(
        cacheBaseDir(),
        `${binaryName}-${hash}-${profile}.node`,
      );

      try {
        await dedupeInFlight(cachePath, async () => {
          if (existsSync(cachePath)) return;
          const bin = napiBin ?? resolveNapiBin();
          await assertCargoAvailable();
          if (opts.logLevel !== "silent") {
            process.stderr.write(
              `[vite-rust] compiling crate "${binaryName}" (${profile}); ` +
                "first build can take 30s+…\n",
            );
          }
          await compileCrate({
            napiBin: bin,
            crateDir,
            binaryName,
            release,
            cachePath,
            napiArgs: opts.napiArgs,
          });
        });
      } catch (err) {
        return this.error((err as Error).message);
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
