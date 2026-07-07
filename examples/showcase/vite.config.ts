import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

import { rustPlugin } from "vite-plugin-native-rust";

export default defineConfig({
  // profile: "release" — all four demo agents independently found that debug
  // dev builds don't just understate the Rust numbers, they can INVERT them
  // (dev AVIF encode: 2032ms vs release 26.7ms; dev lol_html lost to cheerio).
  // A benchmark showcase must not lie in dev; slower rebuilds are the price.
  plugins: [rustPlugin({ profile: "release" }), reactRouter()],
});
