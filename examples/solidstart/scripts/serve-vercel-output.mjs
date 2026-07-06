// Local preview of the *deploy artifact* — not `vinxi start`.
//
// With Nitro's `vercel` preset there is no local production server; the
// honest local production check is to run the exact function bundle Vercel
// deploys: `.vercel/output/functions/__fallback.func/index.mjs`, whose
// default export is a Node `(req, res)` listener (launcherType "Nodejs").
// Static assets from `.vercel/output/static` are served first, everything
// else falls through to the function — a rough approximation of Vercel's
// routing that is enough to verify the native addon was shipped with the
// bundle, loads, and the Rust routes render.
//
// Run after `npm run build`:  npm run preview  (then curl :4500)
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4500);
const exampleDir = fileURLToPath(new URL("..", import.meta.url));
const funcDir = join(exampleDir, ".vercel/output/functions/__fallback.func");
const staticDir = join(exampleDir, ".vercel/output/static");
const handlerPath = join(funcDir, "index.mjs");

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

const { default: listener } = await import(handlerPath);
if (typeof listener !== "function") {
  console.error(
    "[preview] expected the function entry to default-export a Node listener — " +
      "the Nitro vercel entry shape may have changed.",
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

  try {
    listener(req, res);
  } catch (error) {
    console.error("[preview] handler error:", error);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`[preview] serving .vercel/output at http://localhost:${PORT}`);
});
