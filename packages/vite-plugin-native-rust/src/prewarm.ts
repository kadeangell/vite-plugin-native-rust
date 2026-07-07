import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { collectClosureInputs } from "./closure.ts";
import {
  assertCargoAvailable,
  compileCrate,
  type CompileParams,
  ensureCrateBinaryName,
  resolveNapiBin,
} from "./compile.ts";
import { findCargoToml, hashInputs } from "./crate.ts";
import { dedupeInFlight } from "./dedupe.ts";
import type { ResolvedOptions } from "./options.ts";
import { getToolchainKey, toolchainKeyString } from "./toolchain.ts";
import { resolveRelease } from "./vitest.ts";

/**
 * Dev-server pre-warm (issue #5).
 *
 * The first dev request that triggers a cold cargo compile can exceed a
 * framework's module-runner timeout (Nitro's is 60s → 500, and the failed
 * module fetch stays cached until restart). The fix is to start compiling at
 * `configureServer` time so the build races the developer's first click
 * instead of blocking inside it.
 *
 * Discovery problem: at server startup the plugin has not seen any `.rs`
 * import yet, so it does not know which crates exist. Two complementary
 * sources solve that:
 *
 *  1. A tiny manifest in the cache dir recording every crate dir the plugin
 *     has ever compiled (written on each successful `load`). Zero config; it
 *     covers the common cold case — a source/toolchain change invalidated the
 *     content hash, so the *binary* is cold while the manifest still knows the
 *     crate. It does not survive a wholesale cache-dir wipe (by design: the
 *     cache dir is the plugin's only owned location).
 *  2. An explicit `prewarm: string[]` option of crate anchors (a `.rs` file or
 *     crate dir, resolved against the Vite root) for first-ever runs and
 *     freshly cloned repos, where no manifest exists yet.
 */

const MANIFEST_NAME = "prewarm-manifest.json";
const MANIFEST_VERSION = 1;

interface ManifestShape {
  version: number;
  crates: string[];
}

/** Absolute path of the pre-warm manifest inside a cache dir. */
export function prewarmManifestPath(cacheBase: string): string {
  return join(cacheBase, MANIFEST_NAME);
}

function isValidManifest(value: unknown): value is ManifestShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ManifestShape>;
  return (
    candidate.version === MANIFEST_VERSION &&
    Array.isArray(candidate.crates) &&
    candidate.crates.every((c) => typeof c === "string" && c.length > 0)
  );
}

/**
 * Read the crate dirs remembered from previous sessions. Tolerant by design:
 * a missing, corrupt, or wrong-version manifest yields `[]` (never throws),
 * and entries whose `Cargo.toml` has since disappeared are filtered out.
 */
export function readPrewarmManifest(cacheBase: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(prewarmManifestPath(cacheBase), "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isValidManifest(parsed)) return [];

  const existing = parsed.crates.filter((dir) =>
    existsSync(join(dir, "Cargo.toml")),
  );
  return [...new Set(existing)].sort();
}

/**
 * Record a successfully compiled crate dir so the next dev session can
 * pre-warm it. Merges with (and prunes stale entries from) the existing
 * manifest, then writes atomically (tmp + rename) so a concurrent reader
 * never sees a partial file. Never throws — a manifest write failure must not
 * break a working compile; it is reported through `onWarn` instead.
 */
export function recordCrateInManifest(
  cacheBase: string,
  crateDir: string,
  onWarn?: (message: string) => void,
): void {
  try {
    const crates = [...new Set([...readPrewarmManifest(cacheBase), crateDir])].sort();
    const manifest: ManifestShape = { version: MANIFEST_VERSION, crates };
    const dest = prewarmManifestPath(cacheBase);
    mkdirSync(cacheBase, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  } catch (err) {
    onWarn?.(
      `[vite-rust] could not update the pre-warm manifest in "${cacheBase}" ` +
        `(pre-warm will not remember this crate): ${(err as Error).message}`,
    );
  }
}

/** Injectable pieces of the compile pipeline (tests stub the heavy parts). */
export interface CompilePipelineDeps {
  ensureBinaryName: typeof ensureCrateBinaryName;
  collectInputs: typeof collectClosureInputs;
  resolveBin: typeof resolveNapiBin;
  /** Toolchain fingerprint string folded into the cache hash. */
  toolchainString: (napiBin: string | null) => Promise<string>;
  hash: typeof hashInputs;
  dedupe: typeof dedupeInFlight;
  assertCargo: typeof assertCargoAvailable;
  compile: (params: CompileParams) => Promise<void>;
}

const defaultDeps: CompilePipelineDeps = {
  ensureBinaryName: ensureCrateBinaryName,
  collectInputs: collectClosureInputs,
  resolveBin: resolveNapiBin,
  toolchainString: async (napiBin) => toolchainKeyString(await getToolchainKey(napiBin)),
  hash: hashInputs,
  dedupe: dedupeInFlight,
  assertCargo: assertCargoAvailable,
  compile: compileCrate,
};

export interface EnsureCompiledParams {
  crateDir: string;
  /** Resolved absolute cache dir the hashed `.node` files live in. */
  cacheBase: string;
  opts: ResolvedOptions;
  watchMode: boolean;
  underVitest: boolean;
  /** Non-fatal notices (generated package.json, metadata fallback). */
  onWarn: (message: string) => void;
}

export interface CompiledCrate {
  /** Absolute path of the cached `.node` addon (also the dedupe key). */
  cachePath: string;
  binaryName: string;
  /** Content hash over the crate's local closure + toolchain. */
  hash: string;
  /** Full local input closure — the caller's watch set. */
  inputs: string[];
  profile: "debug" | "release";
}

/**
 * The single compile-through-cache pipeline: resolve the crate's binary name,
 * hash its full local closure + toolchain, and compile into the cache unless
 * the hashed binary already exists — all coalesced per `cachePath` via
 * `dedupeInFlight`. Both `load` and the dev pre-warm call THIS function, so a
 * request arriving while a pre-warm compile is in flight joins that compile
 * (identical inputs → identical cachePath → identical dedupe key) instead of
 * racing a second cargo process.
 */
export async function ensureCrateCompiled(
  params: EnsureCompiledParams,
  deps: Partial<CompilePipelineDeps> = {},
): Promise<CompiledCrate> {
  const { crateDir, cacheBase, opts, watchMode, underVitest, onWarn } = params;
  const d: CompilePipelineDeps = { ...defaultDeps, ...deps };

  const config = d.ensureBinaryName(crateDir, opts.generateCratePackageJson);
  if (config.generatedMessage) onWarn(config.generatedMessage);
  const binaryName = config.binaryName;

  // Full local dependency closure (crate + path/workspace deps + workspace
  // Cargo.toml + lockfile): folds into the cache hash (and the caller's watch
  // set) so a sibling path-dep or lockfile change recompiles.
  const inputs = await d.collectInputs(crateDir, { onWarn });

  // Toolchain fingerprint in the key: a rustc / napi-cli upgrade invalidates
  // even byte-identical sources. Resolve the CLI defensively so computing the
  // key never hard-fails before the actual compile step.
  let napiBin: string | null = null;
  try {
    napiBin = d.resolveBin();
  } catch {
    napiBin = null;
  }
  const toolchain = await d.toolchainString(napiBin);
  const hash = d.hash(crateDir, inputs, toolchain);

  // Both profiles overwrite the same napi output path, so the profile is part
  // of the cache key and filename.
  const release = resolveRelease(opts.profile, watchMode, underVitest);
  const profile = release ? "release" : "debug";
  const cachePath = join(cacheBase, `${binaryName}-${hash}-${profile}.node`);

  await d.dedupe(cachePath, async () => {
    if (existsSync(cachePath)) return;
    const bin = napiBin ?? d.resolveBin();
    await d.assertCargo();
    if (opts.logLevel !== "silent") {
      process.stderr.write(
        `[vite-rust] compiling crate "${binaryName}" (${profile}); ` +
          "first build can take 30s+…\n",
      );
    }
    await d.compile({
      napiBin: bin,
      crateDir,
      binaryName,
      release,
      cachePath,
      napiArgs: opts.napiArgs,
    });
  });

  return { cachePath, binaryName, hash, inputs, profile };
}

/**
 * Turn a `prewarm` anchor (a `.rs` file, a `Cargo.toml`, or a crate dir —
 * absolute or Vite-root-relative) into a crate dir, or `null` (with a warning)
 * when no crate is found there.
 */
function resolveAnchor(
  root: string,
  anchor: string,
  onWarn: (message: string) => void,
): string | null {
  const abs = isAbsolute(anchor) ? anchor : resolve(root, anchor);

  let isDir = false;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    onWarn(
      `[vite-rust] prewarm anchor "${anchor}" does not exist ` +
        `(resolved to "${abs}") — skipping it.`,
    );
    return null;
  }

  const crateDir = isDir
    ? existsSync(join(abs, "Cargo.toml"))
      ? abs
      : null
    : findCargoToml(abs);
  if (!crateDir) {
    onWarn(
      `[vite-rust] prewarm anchor "${anchor}" is not inside a Cargo crate ` +
        `(no Cargo.toml at or above "${abs}") — skipping it.`,
    );
  }
  return crateDir;
}

export interface PrewarmParams {
  root: string;
  cacheBase: string;
  opts: ResolvedOptions;
  /** Progress lines; suppressed when `opts.logLevel === "silent"`. */
  onLog: (message: string) => void;
  /** Warnings; always emitted. */
  onWarn: (message: string) => void;
}

export interface PrewarmResult {
  warmed: string[];
  failed: string[];
}

/**
 * Pre-compile every discoverable crate (manifest ∪ `prewarm` anchors) through
 * {@link ensureCrateCompiled}. Sequential on purpose — cargo builds are
 * already parallel internally. Per-crate failures are warnings, never throws:
 * a broken pre-warm must leave the dev server exactly as healthy as before
 * this feature existed (the crate just compiles on first import instead).
 */
export async function prewarmCrates(
  params: PrewarmParams,
  deps: Partial<CompilePipelineDeps> = {},
): Promise<PrewarmResult> {
  const { root, cacheBase, opts, onLog, onWarn } = params;
  if (opts.prewarm === false) return { warmed: [], failed: [] };
  const info = (message: string): void => {
    if (opts.logLevel !== "silent") onLog(message);
  };

  const fromManifest = readPrewarmManifest(cacheBase);
  const fromAnchors = opts.prewarm
    .map((anchor) => resolveAnchor(root, anchor, onWarn))
    .filter((dir): dir is string => dir !== null);
  const crateDirs = [...new Set([...fromManifest, ...fromAnchors])];
  if (crateDirs.length === 0) return { warmed: [], failed: [] };

  info(
    `[vite-rust] pre-warming ${crateDirs.length} crate(s) so the first ` +
      "request doesn't wait on cargo…\n",
  );

  const warmed: string[] = [];
  const failed: string[] = [];
  for (const crateDir of crateDirs) {
    try {
      await ensureCrateCompiled(
        { crateDir, cacheBase, opts, watchMode: true, underVitest: false, onWarn },
        deps,
      );
      warmed.push(crateDir);
    } catch (err) {
      failed.push(crateDir);
      onWarn(
        `[vite-rust] pre-warm failed for crate "${crateDir}" (dev server ` +
          "unaffected; it will compile on first import instead): " +
          `${(err as Error).message}`,
      );
    }
  }

  if (warmed.length > 0) {
    info(
      `[vite-rust] pre-warm complete (${warmed.length}/${crateDirs.length} ` +
        "crate(s) ready)\n",
    );
  }
  return { warmed, failed };
}
