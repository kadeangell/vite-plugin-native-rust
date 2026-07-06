/**
 * Client-only development entry (plain `vite` without `--mode ssr`). Not used
 * by `npm run dev`, which runs SSR dev mode — kept because Qwik's Vite plugin
 * expects it to exist for the non-SSR dev fallback.
 */
import { render, type RenderOptions } from "@builder.io/qwik";
import Root from "./root";

export default function (opts: RenderOptions) {
  return render(document, <Root />, opts);
}
