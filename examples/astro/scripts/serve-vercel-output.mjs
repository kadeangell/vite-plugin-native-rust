// Local preview of the *deploy artifact* — not `astro preview`.
//
// `@astrojs/vercel` does not support `astro preview`; the honest local
// production check is to serve the exact function bundle that Vercel would
// run: `.vercel/output/functions/_render.func/.../entry.mjs`, whose default
// export is `{ fetch }` — a web-standard fetch handler (the shape Vercel's
// Node launcher invokes). Static assets from `.vercel/output/static` are
// served first, everything else falls through to the function — a rough
// approximation of Vercel's routing that is enough to verify the native addon
// loads and the Rust routes render from the traced bundle.
//
// Run after `npm run build`:  npm run preview  (then curl :4400)
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4400);
const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const funcDir = join(exampleDir, ".vercel/output/functions/_render.func");
const staticDir = join(exampleDir, ".vercel/output/static");
const handlerPath = join(funcDir, "examples/astro/dist/server/entry.mjs");

if (!existsSync(handlerPath)) {
  console.error(
    `[preview] function entry not found at ${handlerPath} — run "npm run build" first.`,
  );
  process.exit(1);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const { default: handler } = await import(handlerPath);
if (typeof handler?.fetch !== "function") {
  console.error(
    "[preview] expected the function entry to default-export { fetch } — " +
      "the @astrojs/vercel entry shape may have changed.",
  );
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const staticPath = normalize(join(staticDir, url.pathname));
  if (
    staticPath.startsWith(staticDir) &&
    existsSync(staticPath) &&
    statSync(staticPath).isFile()
  ) {
    res.writeHead(200, {
      "Content-Type": MIME[extname(staticPath)] ?? "application/octet-stream",
    });
    res.end(readFileSync(staticPath));
    return;
  }

  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: "half",
  });
  Promise.resolve(handler.fetch(request))
    .then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })
    .catch((error) => {
      console.error("[preview] handler error:", error);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal Server Error");
    });
});

server.listen(PORT, () => {
  console.log(`[preview] serving .vercel/output at http://localhost:${PORT}`);
});
