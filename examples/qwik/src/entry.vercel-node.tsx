/**
 * Vercel Node-function entry. Qwik City's official Vercel adapter is
 * edge-only (`runtime: "edge"` is hard-coded), and edge functions cannot load
 * native addons — so this example deploys through Qwik City's generic Node
 * middleware instead, wrapped by a Vercel Node function (api/entry.ts).
 *
 * This entry exports the bare (req, res) handler shape Vercel's Node runtime
 * invokes. Static assets never reach it: Vercel serves dist/ from its static
 * layer first and only rewrites cache misses to the function.
 */
import { createQwikCity } from "@builder.io/qwik-city/middleware/node";
import qwikCityPlan from "@qwik-city-plan";
import type { IncomingMessage, ServerResponse } from "node:http";
import render from "./entry.ssr";

const { router, notFound } = createQwikCity({
  render,
  qwikCityPlan,
  // Vercel terminates TLS in front of the function; reconstruct the public
  // origin from the forwarded host so Qwik City's URL/CSRF handling sees the
  // real deployment origin instead of an internal address.
  getOrigin: (req) => {
    const proto = req.headers["x-forwarded-proto"] ?? "https";
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    return `${proto}://${host}`;
  },
});

export default function handler(req: IncomingMessage, res: ServerResponse) {
  router(req, res, () => {
    notFound(req, res, () => {
      res.statusCode = 404;
      res.end("404 not found");
    });
  });
}
