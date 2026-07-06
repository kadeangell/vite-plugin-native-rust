import { isAbsolute, resolve } from "node:path";

import type { Plugin } from "vite";

const PREFIX = "[vite-plugin-native-rust] rustTestStub";

function fail(message: string): never {
  throw new Error(`${PREFIX}: ${message}`);
}

/**
 * A JS stand-in for `.rs` imports in tests.
 *
 * Returns an `enforce: 'pre'` Vite plugin whose `resolveId` redirects any import
 * specifier ending with one of the mapping keys to the mapped replacement
 * module. Use it when you want tests to run **without** a Rust toolchain (CI
 * without cargo) or to deliberately isolate a suite from the native code, by
 * pointing at a semantically-equivalent JS twin. When you instead want to
 * exercise the real compiled crate, add {@link rustPlugin} to the vitest config
 * and skip this entirely — see docs/testing.md.
 *
 * @param mapping specifier-suffix → replacement module. Keys are matched with
 *   `endsWith` (e.g. `"/native/src/lib.rs"` catches every relative spelling of
 *   that import). Values are resolved against the Vite root, or used as-is when
 *   absolute.
 *
 * @example
 * ```ts
 * rustTestStub({ "/native/src/lib.rs": "./app/native-twin.ts" })
 * ```
 */
export function rustTestStub(mapping: Record<string, string>): Plugin {
  if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping)) {
    fail("expected a mapping object of { specifierSuffix: replacementModule }.");
  }

  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    fail("the mapping is empty — give it at least one { key: replacement } pair.");
  }
  for (const [key, replacement] of entries) {
    if (typeof key !== "string" || key.trim() === "") {
      fail("every mapping key must be a non-empty string.");
    }
    if (typeof replacement !== "string" || replacement.trim() === "") {
      fail(`replacement for "${key}" must be a non-empty string, got ${JSON.stringify(replacement)}.`);
    }
  }

  let root = process.cwd();

  return {
    name: "vite-rust-test-stub",
    enforce: "pre",

    configResolved(config) {
      root = config.root;
    },

    resolveId(source) {
      const clean = source.split("?")[0];
      for (const [key, replacement] of entries) {
        if (clean.endsWith(key)) {
          return isAbsolute(replacement) ? replacement : resolve(root, replacement);
        }
      }
      return null;
    },
  };
}
