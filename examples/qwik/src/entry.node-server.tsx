/**
 * Local production entry (`npm run preview`): a plain node:http server around
 * Qwik City's Node middleware, serving the client build from dist/ itself.
 * The Vercel deploy does NOT use this file — see entry.vercel-node.tsx, which
 * exports the bare handler and lets Vercel's static layer serve dist/.
 */
import { createQwikCity } from "@builder.io/qwik-city/middleware/node";
import qwikCityPlan from "@qwik-city-plan";
import { createServer } from "node:http";
import render from "./entry.ssr";

const PORT = process.env.PORT ?? 3000;

const { router, notFound, staticFile } = createQwikCity({
  render,
  qwikCityPlan,
  static: {
    cacheControl: "public, max-age=31536000, immutable",
  },
});

const server = createServer((req, res) => {
  staticFile(req, res, () => {
    router(req, res, () => {
      notFound(req, res, () => {
        res.statusCode = 404;
        res.end("404 not found");
      });
    });
  });
});

server.listen(PORT, () => {
  console.log(`Qwik node server listening on http://localhost:${PORT}`);
});
