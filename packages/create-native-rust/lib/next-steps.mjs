// Builds the "next steps" text shown after a successful scaffold. Pure: takes
// the display dir (as the user typed it) and the crate name, returns a string.

/**
 * @param {object} params
 * @param {string} params.displayDir  The dir as the user passed it (for copy-paste paths).
 * @param {string} params.name        The crate/binary name.
 */
export function nextSteps({ displayDir, name }) {
  const trimmed = displayDir.replace(/\/+$/, "");
  // Absolute paths stay as-is; relative paths get a leading "./" for a
  // copy-pasteable import specifier.
  const base = trimmed.startsWith("/")
    ? trimmed
    : `./${trimmed.replace(/^\.\/+/, "")}`;
  const importPath = `${base}/src/lib.rs`;
  return `Scaffolded napi-rs crate "${name}" in ${displayDir}/

Next steps:

  1. Install the Vite plugin (and the napi CLI it drives) in your app:

       npm i -D vite-plugin-native-rust @napi-rs/cli

  2. Add the plugin to your vite.config (before your framework plugin):

       import { rustPlugin } from "vite-plugin-native-rust";

       export default defineConfig({
         plugins: [rustPlugin(), /* ...your other plugins */],
       });

  3. Let TypeScript resolve the generated ".d.rs.ts" types by enabling this in
     your tsconfig.json compilerOptions:

       "allowArbitraryExtensions": true

  4. Import the crate from server-only code (e.g. a ".server.ts" module, so the
     ".rs" import never leaks into the client bundle):

       import { add, sumTo } from "${importPath}";

       const five = add(2, 3);          // sync, on the main thread
       const total = await sumTo(1_000); // async, off the event loop

  Note: the first dev-server request that touches the crate triggers a cargo
  build (~30s cold, cached after that), so the initial response will pause while
  Rust compiles. Subsequent requests hit the cached native addon.
`;
}
