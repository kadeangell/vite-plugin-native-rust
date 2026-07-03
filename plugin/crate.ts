import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, parse, relative, sep } from "node:path";

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
 * sha256 hex over each input's crate-relative path + '\0' + file contents.
 * The path is folded in so a rename changes the hash even when contents are
 * identical. Throws a clear Error naming `crateDir` if it can't be read.
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

  const hash = createHash("sha256");
  for (const input of inputs) {
    let contents: Buffer;
    try {
      contents = readFileSync(input);
    } catch (err) {
      throw new Error(
        `Cannot hash Rust crate at "${crateDir}": failed to read "${input}": ${
          (err as Error).message
        }`,
      );
    }
    // Normalize the relative path to '/' so hashes match across platforms.
    const relPath = relative(crateDir, input).split(sep).join("/");
    hash.update(relPath);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}
