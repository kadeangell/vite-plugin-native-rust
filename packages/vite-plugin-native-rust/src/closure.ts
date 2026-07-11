import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { collectCrateInputs } from "./crate.ts";
import {
  describeFdPressure,
  execFileTransientRetry,
  processFdCount,
  type FdCounter,
} from "./spawn.ts";

/** The slice of `cargo metadata --format-version 1` output we rely on. */
export interface CargoMetadata {
  packages: Array<{
    name: string;
    manifest_path: string;
    /** `null` for path/workspace crates; a `registry+`/`git+` URL otherwise. */
    source: string | null;
  }>;
  workspace_root: string;
}

/** Runs `cargo metadata` for the crate at `crateDir`. Injectable for tests. */
export type MetadataRunner = (crateDir: string) => Promise<CargoMetadata>;

/** Runs `cargo generate-lockfile` for the crate at `crateDir`. Injectable for tests. */
export type LockfileRunner = (crateDir: string) => Promise<void>;

export interface ClosureOptions {
  /** Override the metadata runner (tests inject a stub / spy). */
  runMetadata?: MetadataRunner;
  /** Override the lockfile generator (tests inject a stub / spy). */
  runGenerateLockfile?: LockfileRunner;
  /** Surface a non-fatal warning (e.g. the metadata fallback). */
  onWarn?: (message: string) => void;
  /** Override the open-fd counter (tests inject a fixed value). */
  fdCount?: FdCounter;
}

/**
 * Enrichment appended to a fallback warning when the spawn failure was really
 * fd-table exhaustion (issue #6): a `cargo metadata`/`generate-lockfile` spawn
 * that dies under fd pressure isn't a manifest problem, so name the true cause.
 * Empty string below the pressure threshold — the same DRY gate the other
 * failure paths use.
 */
function fdPressureSuffix(fdCount: FdCounter): string {
  const pressure = describeFdPressure(fdCount());
  return pressure === null ? "" : ` — ${pressure}`;
}

// Both default runners retry once on transient spawn errors (macOS EBADF
// flake, issue #6) so a system hiccup doesn't degrade to single-crate hashing.
const defaultRunMetadata: MetadataRunner = async (crateDir) => {
  const { stdout } = await execFileTransientRetry(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", join(crateDir, "Cargo.toml")],
    { cwd: crateDir, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as CargoMetadata;
};

const defaultRunGenerateLockfile: LockfileRunner = async (crateDir) => {
  await execFileTransientRetry(
    "cargo",
    ["generate-lockfile", "--manifest-path", join(crateDir, "Cargo.toml")],
    { cwd: crateDir, maxBuffer: 16 * 1024 * 1024 },
  );
};

/**
 * What `cargo metadata` tells us about the local (non-registry) footprint of a
 * crate. `.rs` files are re-enumerated live on every call, so only these
 * comparatively stable, expensive-to-derive facts are cached.
 */
interface ResolvedLayout {
  /** Directories of every path/workspace crate in the graph. */
  localCrateDirs: string[];
  /** Manifest paths whose mtimes gate cache reuse (all local + workspace). */
  manifestPaths: string[];
  /** Workspace-level Cargo.toml (may equal the crate's own). */
  workspaceManifest: string;
  /** Absolute Cargo.lock path when one exists, else null. */
  lockfile: string | null;
}

interface CacheEntry {
  layout: ResolvedLayout;
  signature: string;
}

// Per-crateDir memo of the resolved layout, guarded by manifest mtimes so a
// dependency-graph change (which always edits a Cargo.toml) forces a re-run
// while source-only edits reuse it (sharp edge #4: metadata costs 100-300ms).
const layoutCache = new Map<string, CacheEntry>();

// Crate dirs for which `cargo generate-lockfile` already ran (or failed) this
// session, so a missing/ungeneratable lockfile costs one subprocess and one
// warning — not one per `load()` call.
const lockfileGenerationAttempted = new Set<string>();

/**
 * Walk up from `crateDir` looking for a `Cargo.lock`. Mirrors cargo's own
 * workspace-root discovery: a workspace member's lockfile lives at the
 * workspace root, which is always at or above the crate directory.
 */
function findExistingLockfile(crateDir: string): string | null {
  let dir = crateDir;
  const { root } = parse(dir);
  while (true) {
    const candidate = join(dir, "Cargo.lock");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Cache-key stability for lockfile-less crates (issue #4): make sure a
 * `Cargo.lock` exists BEFORE the first hash, so the key is identical across
 * every pipeline/build step of the session and across future sessions.
 *
 * Why explicit generation, given that `cargo metadata` (which runs right
 * after) also writes `Cargo.lock` as a side effect of dependency resolution?
 * Two reasons, both verified empirically:
 *
 * 1. **The fallback path had no lockfile at all.** When `cargo metadata`
 *    fails, `collectClosureInputs` falls back to single-crate hashing — which
 *    generated nothing. The first compile then created the lockfile, changing
 *    the dependency-closure hash, and the next pipeline recompiled an
 *    identical crate (~24s wasted; found by the Nuxt example's multi-pipeline
 *    build). `cargo generate-lockfile` is metadata-only (no compile) and
 *    cheap, and its output lands where the fallback's `collectCrateInputs`
 *    picks it up.
 * 2. **Determinism should not hinge on a side effect.** Relying on
 *    `cargo metadata`'s implicit write couples key stability to flags and
 *    environment (`--frozen`/`--locked`/offline modes suppress it). Running
 *    `generate-lockfile` first makes the ordering explicit: lockfile exists →
 *    metadata resolves against it → hash includes it.
 *
 * Graceful fallback: if generation fails (no network on a cold registry, odd
 * toolchain), warn once per crate and proceed with the old behavior — a
 * missing lockfile must never hard-fail dev.
 */
async function ensureLockfile(
  crateDir: string,
  runGenerateLockfile: LockfileRunner,
  fdCount: FdCounter,
  onWarn?: (message: string) => void,
): Promise<void> {
  if (findExistingLockfile(crateDir) !== null) return;
  if (lockfileGenerationAttempted.has(crateDir)) return;
  lockfileGenerationAttempted.add(crateDir);
  try {
    await runGenerateLockfile(crateDir);
  } catch (err) {
    onWarn?.(
      `[vite-plugin-native-rust] crate "${crateDir}" has no Cargo.lock and ` +
        `\`cargo generate-lockfile\` failed — the first compile will create ` +
        `one, which changes the cache key and forces one extra recompile in ` +
        `later build steps. Generate and commit a Cargo.lock to avoid this: ` +
        `${(err as Error).message}${fdPressureSuffix(fdCount)}`,
    );
  }
}

function mtimeSignature(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        return `${p}:${statSync(p).mtimeMs}`;
      } catch {
        return `${p}:missing`;
      }
    })
    .join("|");
}

function deriveLayout(metadata: CargoMetadata): ResolvedLayout {
  const local = metadata.packages.filter((pkg) => pkg.source === null);
  const localCrateDirs = [...new Set(local.map((pkg) => dirname(pkg.manifest_path)))];

  const workspaceManifest = join(metadata.workspace_root, "Cargo.toml");
  const manifestSet = new Set(local.map((pkg) => pkg.manifest_path));
  if (existsSync(workspaceManifest)) manifestSet.add(workspaceManifest);

  const lockCandidate = join(metadata.workspace_root, "Cargo.lock");
  const lockfile = existsSync(lockCandidate) ? lockCandidate : null;

  return {
    localCrateDirs,
    manifestPaths: [...manifestSet],
    workspaceManifest,
    lockfile,
  };
}

function collectRustFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      found.push(full);
    }
  }
  return found;
}

/** Per-crate source files: manifest, `build.rs`, and everything under `src/`. */
function crateFiles(crateDir: string): string[] {
  const files: string[] = [];
  const manifest = join(crateDir, "Cargo.toml");
  if (existsSync(manifest)) files.push(manifest);
  const buildRs = join(crateDir, "build.rs");
  if (existsSync(buildRs)) files.push(buildRs);
  const srcDir = join(crateDir, "src");
  if (existsSync(srcDir)) files.push(...collectRustFiles(srcDir));
  return files;
}

function layoutToInputs(layout: ResolvedLayout): string[] {
  const inputs = new Set<string>();
  for (const dir of layout.localCrateDirs) {
    for (const file of crateFiles(dir)) inputs.add(file);
  }
  inputs.add(layout.workspaceManifest);
  if (layout.lockfile) inputs.add(layout.lockfile);
  return [...inputs].filter(existsSync).sort();
}

async function resolveLayout(
  crateDir: string,
  runMetadata: MetadataRunner,
): Promise<ResolvedLayout> {
  const cached = layoutCache.get(crateDir);
  if (cached && mtimeSignature(cached.layout.manifestPaths) === cached.signature) {
    return cached.layout;
  }

  const metadata = await runMetadata(crateDir);
  const layout = deriveLayout(metadata);
  layoutCache.set(crateDir, {
    layout,
    signature: mtimeSignature(layout.manifestPaths),
  });
  return layout;
}

/**
 * The complete local input set for a crate: the crate itself plus every
 * path/workspace dependency's sources, the workspace `Cargo.toml`, and the
 * lockfile — wherever they live. Folded into both the cache hash and the
 * `addWatchFile` set, so a change in a sibling path-dep or the lockfile
 * recompiles instead of silently serving a stale binary.
 *
 * A missing lockfile is generated first (`cargo generate-lockfile`, see
 * `ensureLockfile`) so it exists — and is part of the returned input set,
 * hence hashed and watched — from the very first call, keeping the cache key
 * stable across pipelines instead of shifting after the first compile.
 *
 * Falls back to single-crate collection (with a warning) if `cargo metadata`
 * fails — a metadata hiccup must not hard-fail dev.
 */
export async function collectClosureInputs(
  crateDir: string,
  options: ClosureOptions = {},
): Promise<string[]> {
  const runMetadata = options.runMetadata ?? defaultRunMetadata;
  const runGenerateLockfile =
    options.runGenerateLockfile ?? defaultRunGenerateLockfile;
  const fdCount = options.fdCount ?? processFdCount;
  await ensureLockfile(crateDir, runGenerateLockfile, fdCount, options.onWarn);
  try {
    const layout = await resolveLayout(crateDir, runMetadata);
    return layoutToInputs(layout);
  } catch (err) {
    options.onWarn?.(
      `[vite-plugin-native-rust] \`cargo metadata\` failed for "${crateDir}"; ` +
        `falling back to single-crate hashing (path-dep and workspace changes ` +
        `will not be tracked): ${(err as Error).message}${fdPressureSuffix(fdCount)}`,
    );
    return collectCrateInputs(crateDir);
  }
}

/**
 * Test-only: drop the layout cache and the lockfile-generation memo so a
 * fresh metadata run / generation attempt can be observed.
 */
export function resetClosureCacheForTests(): void {
  layoutCache.clear();
  lockfileGenerationAttempted.clear();
}
