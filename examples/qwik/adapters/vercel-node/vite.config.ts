/**
 * SSR build config. Uses the generic node-server adapter (NOT vercel-edge —
 * edge functions cannot load native addons; see README). Emits two entries
 * into server/:
 *   - entry.vercel-node.js   → wrapped by api/entry.ts on Vercel
 *   - entry.node-server.js   → `npm run preview` local production server
 */
import { nodeServerAdapter } from "@builder.io/qwik-city/adapters/node-server/vite";
import { extendConfig } from "@builder.io/qwik-city/vite";
import baseConfig from "../../vite.config";

// Monorepo quirk, not a Qwik/plugin issue: this workspace nests Vite 7 while
// the repo root hoists Vite 6 for other examples, and qwik-city's extendConfig
// types resolve against the hoisted copy — two nominally distinct but
// structurally compatible UserConfigExport types. The cast bridges them.
export default extendConfig(baseConfig as Parameters<typeof extendConfig>[0], () => {
  return {
    build: {
      ssr: true,
      rollupOptions: {
        input: [
          "src/entry.vercel-node.tsx",
          "src/entry.node-server.tsx",
          "@qwik-city-plan",
        ],
      },
    },
    plugins: [nodeServerAdapter({ name: "vercel-node" })],
  };
});
