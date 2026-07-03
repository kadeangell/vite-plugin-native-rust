import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

// The integration suite builds with RR_NO_VERCEL=1 to get the standard node
// server output (build/server/index.js) that `react-router-serve` runs.
// Production and Vercel builds leave the variable unset and keep the preset.
const presets = process.env.RR_NO_VERCEL ? [] : [vercelPreset()];

export default {
  // Server-side rendering enabled (framework mode default).
  ssr: true,
  presets,
} satisfies Config;
