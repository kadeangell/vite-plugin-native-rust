// Prepare isolated (non-workspace) integration fixtures. The react-router-v8
// fixture runs Vite 8, which cannot coexist with the vite-6 example in a single
// npm workspace install, so it gets its own node_modules here. Idempotent:
// installs only when needed, and always refreshes the installed plugin copy
// with the freshly built dist so tests exercise what ships.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", ".."); // packages/vite-plugin-native-rust
const distDir = join(pluginDir, "dist");

// Fixtures that install in isolation (marker file proves a completed install).
const isolated = [
  {
    dir: join(here, "..", "fixtures", "react-router-v8"),
    marker: join("node_modules", "react-router"),
  },
];

if (!existsSync(distDir)) {
  console.error("[setup] plugin dist/ missing — run `npm run build` first.");
  process.exit(1);
}

for (const { dir, marker } of isolated) {
  if (!existsSync(join(dir, marker))) {
    console.log(`[setup] installing isolated fixture: ${dir}`);
    execFileSync(
      "npm",
      ["install", "--install-links", "--no-audit", "--no-fund"],
      { cwd: dir, stdio: "inherit" },
    );
  }

  // `--install-links` copies the plugin, so refresh it against the latest dist.
  const installedPlugin = join(dir, "node_modules", "vite-plugin-native-rust");
  if (existsSync(installedPlugin)) {
    const dest = join(installedPlugin, "dist");
    rmSync(dest, { recursive: true, force: true });
    cpSync(distDir, dest, { recursive: true });
  }
}

console.log("[setup] fixtures ready.");
