import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { rustPlugin } from "vite-plugin-native-rust";

export default defineConfig({
  plugins: [
    // rustPlugin() must come before the framework plugins so it claims the
    // `.rs` specifier first (it runs with enforce: "pre").
    rustPlugin(),
    tanstackStart(),
    // The Nitro Vite plugin is TanStack Start's deploy layer: on Vercel it
    // compiles the server build into Build Output API functions.
    nitro(),
    viteReact(),
  ],
});
