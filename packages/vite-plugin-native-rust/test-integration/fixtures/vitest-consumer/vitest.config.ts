import { resolve } from "node:path";

import { rustPlugin, rustTestStub } from "vite-plugin-native-rust";
import { defineConfig } from "vitest/config";

// Two projects, mirroring the issue reporter's setup: each project's `plugins`
// array is its own — vitest projects do not inherit root plugins/resolve, so
// the .rs handling has to be wired per project.
export default defineConfig({
  test: {
    projects: [
      {
        // Real native code: rustPlugin() compiles (or reuses the cached debug
        // binary) exactly like dev. jsdom => ssr=false, so this also exercises
        // the client-graph gate bypass.
        plugins: [rustPlugin({ logLevel: "silent" })],
        test: {
          name: "native",
          include: ["test/native.test.ts"],
          environment: "jsdom",
        },
      },
      {
        // JS twin: rustTestStub redirects the .rs import — no cargo needed.
        plugins: [
          rustTestStub({
            "/native/src/lib.rs": resolve(import.meta.dirname, "app/native-twin.ts"),
          }),
        ],
        test: {
          name: "stub",
          include: ["test/stub.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
