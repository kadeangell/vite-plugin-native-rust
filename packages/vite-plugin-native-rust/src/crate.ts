import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, parse, relative, sep } from "node:path";

/**
 * Re-anchor a fake-absolute id under the Vite project root when needed.
 * rolldown-vite (Vite 8) sometimes passes project-root-relative module ids
 * that LOOK absolute ("/app/core/…") but don't exist on the real filesystem
 * (issue #7). If `path` isn't on disk and `root + path` is, return the
 * re-anchored form; otherwise return `path` unchanged.
 */
export function anchorToRoot(path: string, root: string): string {
  if (existsSync(path)) return path;
  const reAnchored = join(root, path.replace(/^[/\\]+/, ""));
  return existsSync(reAnchored) ? reAnchored : path;
}

/**
 * Walk up from a `.rs` file's directory to the filesystem root, returning the
 * directory that contains `Cargo.toml`, or `null` if none exists on the way up.
 */
export function findCargoToml(fromPath: string): string | null {
  let dir = dirname(fromPath);
  const { root } = parse(dir);

  while (true) {
    if (existsSync(join(dir, "Cargo.toml"))) return dir;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Sorted absolute paths of every file that defines the crate's identity:
 * `Cargo.toml`, `Cargo.lock` (only when present), and all `*.rs` files under
 * `src/` recursively. Sorted so hashing is deterministic across runs.
 */
export function collectCrateInputs(crateDir: string): string[] {
  const cargoToml = join(crateDir, "Cargo.toml");
  if (!existsSync(cargoToml)) {
    throw new Error(`No Cargo.toml found in crate directory: ${crateDir}`);
  }

  const inputs: string[] = [cargoToml];

  const cargoLock = join(crateDir, "Cargo.lock");
  if (existsSync(cargoLock)) inputs.push(cargoLock);

  const srcDir = join(crateDir, "src");
  if (existsSync(srcDir)) {
    inputs.push(...collectRustFiles(srcDir));
  }

  return inputs.sort();
}

function collectRustFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRustFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * sha256 hex over each input's `baseDir`-relative path + '\0' + file contents,
 * plus an optional `extra` string (e.g. a toolchain fingerprint) folded in last.
 * The path is folded in so a rename changes the hash even when contents are
 * identical; the relative path keeps the digest machine-independent. Throws a
 * clear Error naming `baseDir` if any input can't be read.
 */
export function hashInputs(
  baseDir: string,
  inputs: string[],
  extra?: string,
): string {
  const hash = createHash("sha256");
  for (const input of inputs) {
    let contents: Buffer;
    try {
      contents = readFileSync(input);
    } catch (err) {
      throw new Error(
        `Cannot hash Rust crate at "${baseDir}": failed to read "${input}": ${
          (err as Error).message
        }`,
      );
    }
    // Normalize the relative path to '/' so hashes match across platforms.
    const relPath = relative(baseDir, input).split(sep).join("/");
    hash.update(relPath);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  if (extra !== undefined) {
    hash.update("__extra__\0");
    hash.update(extra);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * sha256 hex of a single crate's own inputs (`Cargo.toml`, `Cargo.lock`, and
 * `src/**.rs`). Retained for the metadata fallback path; the primary path hashes
 * the full local dependency closure via `hashInputs`.
 */
export function hashCrate(crateDir: string): string {
  let inputs: string[];
  try {
    inputs = collectCrateInputs(crateDir);
  } catch (err) {
    throw new Error(
      `Cannot hash Rust crate at "${crateDir}": ${(err as Error).message}`,
    );
  }
  return hashInputs(crateDir, inputs);
}
