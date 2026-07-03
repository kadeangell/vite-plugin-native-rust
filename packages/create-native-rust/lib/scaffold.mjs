import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * @param {object} params
 * @param {string} params.dir     Target directory (created if missing).
 * @param {string} [params.name]  Binary/crate name; derived from `dir` if omitted.
 * @param {string} [params.cwd]   Base for resolving a relative `dir`.
 * @returns {Promise<{dir: string, name: string, files: string[]}>}
 */
export async function scaffold({ dir, name, cwd = process.cwd() }) {
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

  return { dir: targetDir, name: resolvedName, files: written.sort() };
}
