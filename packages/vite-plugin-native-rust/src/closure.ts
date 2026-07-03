import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { collectCrateInputs } from "./crate.ts";

const execFileAsync = promisify(execFile);

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

export interface ClosureOptions {
  /** Override the metadata runner (tests inject a stub / spy). */
  runMetadata?: MetadataRunner;
  /** Surface a non-fatal warning (e.g. the metadata fallback). */
  onWarn?: (message: string) => void;
}

const defaultRunMetadata: MetadataRunner = async (crateDir) => {
  const { stdout } = await execFileAsync(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", join(crateDir, "Cargo.toml")],
    { cwd: crateDir, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as CargoMetadata;
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
 * Falls back to single-crate collection (with a warning) if `cargo metadata`
 * fails — a metadata hiccup must not hard-fail dev.
 */
export async function collectClosureInputs(
  crateDir: string,
  options: ClosureOptions = {},
): Promise<string[]> {
  const runMetadata = options.runMetadata ?? defaultRunMetadata;
  try {
    const layout = await resolveLayout(crateDir, runMetadata);
    return layoutToInputs(layout);
  } catch (err) {
    options.onWarn?.(
      `[vite-plugin-native-rust] \`cargo metadata\` failed for "${crateDir}"; ` +
        `falling back to single-crate hashing (path-dep and workspace changes ` +
        `will not be tracked): ${(err as Error).message}`,
    );
    return collectCrateInputs(crateDir);
  }
}

/** Test-only: drop the layout cache so a fresh metadata run can be observed. */
export function resetClosureCacheForTests(): void {
  layoutCache.clear();
}
