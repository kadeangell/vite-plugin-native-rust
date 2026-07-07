import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tryGenerateLockfile } from "./lockfile.mjs";
import { crateFiles } from "./templates.mjs";
import { deriveNameFromDir, validateName } from "./validate.mjs";

async function isNonEmptyDir(path) {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Scaffold a napi-rs crate into `dir`.
 *
 * The crate ships with a `Cargo.lock` from birth when cargo is available
 * (`generateLockfile`, default `tryGenerateLockfile`): the Vite plugin folds
 * the lockfile into its content-hash cache key, so a crate born without one
 * would change key after its first compile and cost multi-pipeline builds an
 * extra identical compile (issue #4). Lockfile generation never fails the
 * scaffold — the returned `lockfile` status says what happened.
 *
 * @param {object} params
 * @param {string} params.dir     Target directory (created if missing).
 * @param {string} [params.name]  Binary/crate name; derived from `dir` if omitted.
 * @param {string} [params.cwd]   Base for resolving a relative `dir`.
 * @param {(dir: string) => Promise<{status: string, detail?: string}>} [params.generateLockfile]
 *   Injectable lockfile step (tests stub it; default runs `cargo generate-lockfile`).
 * @returns {Promise<{dir: string, name: string, files: string[], lockfile: {status: string, detail?: string}}>}
 */
export async function scaffold({
  dir,
  name,
  cwd = process.cwd(),
  generateLockfile = tryGenerateLockfile,
}) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("target directory is required");
  }

  const targetDir = isAbsolute(dir) ? dir : resolve(cwd, dir);

  if (await isNonEmptyDir(targetDir)) {
    throw new Error(
      `refusing to scaffold into "${targetDir}" — directory exists and is not empty`,
    );
  }

  const resolvedName = name ?? deriveNameFromDir(targetDir);
  if (resolvedName == null) {
    throw new Error(
      `could not derive a valid crate name from "${dir}" — pass one with --name <binaryName>`,
    );
  }
  validateName(resolvedName);

  const files = crateFiles(resolvedName);
  const written = [];
  for (const [relPath, contents] of Object.entries(files)) {
    const absPath = join(targetDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, "utf8");
    written.push(relPath);
  }

  const lockfile = await generateLockfile(targetDir);
  const allFiles =
    lockfile.status === "generated" ? [...written, "Cargo.lock"] : written;

  return {
    dir: targetDir,
    name: resolvedName,
    files: [...allFiles].sort(),
    lockfile,
  };
}
