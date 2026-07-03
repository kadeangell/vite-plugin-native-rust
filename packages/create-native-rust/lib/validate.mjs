import { basename } from "node:path";

// A name usable as both a Cargo package name and an npm-ish identifier:
// lowercase, starts with a letter, single `-`/`_` separators between segments,
// no leading/trailing separator.
const NAME_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 214;

/**
 * Throws a user-facing Error if `name` is not a valid crate/npm-ish
 * identifier; returns `name` unchanged when valid.
 */
export function validateName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("crate name is empty — pass a name with --name <binaryName>");
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `crate name "${name}" is too long (max ${MAX_NAME_LENGTH} characters)`,
    );
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid crate name "${name}" — use lowercase letters, digits, "-" or "_", ` +
        `starting with a letter (e.g. "my-crate")`,
    );
  }
  return name;
}

/**
 * Best-effort derivation of a valid name from a target directory. Returns the
 * sanitized name, or null when nothing valid can be salvaged (caller should
 * then ask for an explicit --name).
 */
export function deriveNameFromDir(dir) {
  const candidate = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return NAME_RE.test(candidate) ? candidate : null;
}
