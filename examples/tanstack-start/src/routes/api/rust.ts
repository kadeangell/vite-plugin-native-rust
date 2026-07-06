import { createFileRoute } from "@tanstack/react-router";
import { add, sumTo } from "../../server/rust.server";

/**
 * A TanStack Start server route: a file route with only `server.handlers`.
 * It never has a client component, so the `.rs`-backed import above stays
 * server-side by construction.
 */
export const Route = createFileRoute("/api/rust")({
  server: {
    handlers: {
      GET: async () => {
        const start = performance.now();
        const five = add(2, 3);
        const total = await sumTo(1000);
        const ms = performance.now() - start;
        return Response.json({
          add: five,
          sumTo: total,
          ms,
          runtime: `node ${process.version}`,
        });
      },
    },
  },
});
