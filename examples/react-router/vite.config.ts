import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

import { rustPlugin } from "vite-plugin-native-rust";

export default defineConfig({
  plugins: [rustPlugin(), reactRouter()],
});
