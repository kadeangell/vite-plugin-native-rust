import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

import { rustPlugin } from "./plugin/index.ts";

export default defineConfig({
  plugins: [rustPlugin(), reactRouter()],
});
