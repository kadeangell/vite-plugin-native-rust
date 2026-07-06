# Testing with vitest

vitest runs its **own** Vite pipeline with its own config — separate from your
app's `vite.config.ts`. If that pipeline doesn't know about `.rs` imports, vitest
hands the raw Rust source to its parser and collection dies:

```
RolldownError: Parse failure: Expected a semicolon … but found none
1: use std::collections::HashMap;
At file: …/native/src/lib.rs:1:3
```

## Why it's viral

The file that fails isn't the one under test. Any test whose **module graph
transitively reaches** a `.rs` import breaks at collection time — a test that
imports a server module, which imports another server module, which imports the
crate, dies before a single assertion runs. One `.rs` import can take out
unrelated suites.

You have two first-class fixes. Pick per suite; they can coexist across projects.

## Path 1 — real native code (`rustPlugin()` in the vitest config)

Add the plugin to your vitest config exactly like you add it to Vite. It compiles
the crate on the first run (debug profile) and serves the content-hash cache on
every run after — so a machine that has built the crate once pays no compile
cost, and your tests exercise the **real** compiled Rust.

```ts
// vitest.config.ts
import { rustPlugin } from "vite-plugin-native-rust";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [rustPlugin()],
  test: { environment: "node" },
});
```

That's the whole change — zero extra options. Under vitest the plugin
automatically:

- **skips the client-graph gate.** In an app build, importing `.rs` from
  client-reachable code is an error (a `.node` binary can't ship to a browser).
  vitest runs everything in Node — jsdom/happy-dom only emulate the DOM
  in-process — so the gate is bypassed. It protects browsers, not test runners.
- **always emits the dev-shape loader** (require the addon from its absolute
  cache path). The production build shape needs a real bundle write to place the
  addon, and vitest never writes one.
- **compiles in debug** (fast) unless you pin `profile: 'release'`.

Works under both `vitest run` and `vitest --watch`. It needs a Rust toolchain on
the machine (cargo on `PATH`) — if that's a problem in CI, use Path 2.

## Path 2 — a JS twin (`rustTestStub`)

When you'd rather **not** compile Rust in a given suite — CI without a toolchain,
or deliberately isolating a suite from the native code — redirect the `.rs`
import to a semantically-equivalent JS module with `rustTestStub`:

```ts
// vitest.config.ts
import { rustTestStub } from "vite-plugin-native-rust";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    rustTestStub({
      // specifier suffix (matched with endsWith)  ->  replacement module
      "/native/src/lib.rs": "./app/native-twin.ts",
    }),
  ],
});
```

`rustTestStub(mapping)` returns an `enforce: 'pre'` plugin whose `resolveId`
redirects any import ending with a mapping key to the replacement. Replacements
resolve against the Vite root (or pass an absolute path). The twin must export
the same names your code imports (`add`, `sumTo`, …).

Prefer this over Path 1 when there's no cargo in the environment, or when you
want the test to run against a controlled stand-in rather than the native code.

## `test.projects`: mixing both

vitest projects each get their **own** `plugins` array — they do **not** inherit
root-level `plugins` or `resolve.alias`, which is the trap the issue reporter hit
(a root `resolve.alias` silently did nothing). Wire the `.rs` handling into each
project that needs it:

```ts
// vitest.config.ts
import { resolve } from "node:path";

import { rustPlugin, rustTestStub } from "vite-plugin-native-rust";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Real native code.
        plugins: [rustPlugin()],
        test: { name: "native", environment: "node", include: ["test/native/**"] },
      },
      {
        // JS twin — no toolchain needed.
        plugins: [
          rustTestStub({
            "/native/src/lib.rs": resolve(import.meta.dirname, "app/native-twin.ts"),
          }),
        ],
        test: { name: "stub", environment: "node", include: ["test/stub/**"] },
      },
    ],
  },
});
```

Each project instantiates its own plugin, but the compile cache is shared and
safe: in-flight compiles are de-duplicated and cache writes are atomic, so two
project instances racing on the same crate don't corrupt each other — one
compiles, the other reuses the result.

A runnable version of exactly this two-project setup lives in the plugin's
integration fixtures at
[`test-integration/fixtures/vitest-consumer`](https://github.com/kadeangell/vite-plugin-native-rust/tree/main/packages/vite-plugin-native-rust/test-integration/fixtures/vitest-consumer).
