import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import { defineConfig } from "vite";
import { rustPlugin } from "vite-plugin-native-rust";

export default defineConfig(() => {
  return {
    plugins: [
      // rustPlugin() before the framework plugins so it claims `.rs`
      // specifiers first (it also sets enforce: "pre").
      rustPlugin(),
      qwikCity(),
      qwikVite(),
    ],
  };
});
