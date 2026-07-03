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
  buildModuleSource,
  devModuleSource,
  enumerateExports,
  ensureTsconfigOption,
  syncTypeDeclaration,
} from "./codegen.ts";
import { findCargoToml, hashInputs } from "./crate.ts";
import { dedupeInFlight } from "./dedupe.ts";
import { resolveOptions, type RustPluginOptions } from "./options.ts";
import { getToolchainKey, toolchainKeyString } from "./toolchain.ts";

export type { RustPluginOptions } from "./options.ts";

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
      if (opts.emitTypes) ensureTsconfigOption(root);
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
      if (!loadOptions?.ssr) {
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
      // part of the cache key and filename.
      const release =
        opts.profile !== null
          ? opts.profile === "release"
          : this.meta.watchMode !== true;
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

      let keys: string[];
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
      // matches the cached binary, not whatever revision compiled last.
      if (opts.emitTypes) {
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

      if (this.meta.watchMode) {
        return devModuleSource(cachePath, keys);
      }

      const refId = this.emitFile({
        type: "asset",
        fileName: `${binaryName}-${hash}.node`,
        source: readFileSync(cachePath),
      });
      return buildModuleSource(refId, keys);
    },
  };
}

export default rustPlugin;
