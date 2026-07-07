// Resource route: serves the actual encoded thumbnail bytes with the right
// content-type, so the /images page can render real <img> output from both
// engines. Encoded live per request (deliberately uncached — this is a demo
// of the encode itself).
import {
  parseEngine,
  parseThumbParams,
  runJimpThumbnail,
  runRustThumbnail,
} from "../images-pipeline.server";
import type { Route } from "./+types/images.thumb";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const params = parseThumbParams(url.searchParams);
  const engine = parseEngine(url.searchParams);

  const result =
    engine === "jimp" ? await runJimpThumbnail(params) : await runRustThumbnail(params);

  return new Response(new Uint8Array(result.data), {
    headers: {
      "Content-Type": result.contentType,
      "Content-Length": String(result.bytes),
      "Cache-Control": "no-store",
    },
  });
}
