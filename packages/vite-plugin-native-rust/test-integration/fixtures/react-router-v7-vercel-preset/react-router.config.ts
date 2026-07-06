import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// The whole point of this fixture: build with the Vercel preset enabled so the
// server build is split into per-function bundles under build/server/nodejs_*/.
// Issue #1 is that the emitted `.node` asset was dropped from that layout.
export default {
  ssr: true,
  presets: [vercelPreset()],
} satisfies Config;
