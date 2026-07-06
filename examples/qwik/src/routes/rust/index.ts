// Qwik City route endpoint — a route directory with no default-exported
// component. `onGet` runs only on the server; returning JSON here lets a curl
// check validate the deployed addon without parsing HTML.
//
// Deliberately NOT under /api/: on Vercel that prefix is reserved for the
// zero-config functions directory (which hosts the wrapper in api/entry.ts),
// and unmatched /api/* paths 404 before the catch-all rewrite can forward
// them to Qwik City's router.
import type { RequestHandler } from "@builder.io/qwik-city";

import { add, sumTo } from "../../lib/rust.server";

export const onGet: RequestHandler = async ({ json }) => {
  try {
    const five = add(2, 3);
    const total = await sumTo(1_000);
    json(200, { add: five, sumTo: total, runtime: process.version });
  } catch (error: unknown) {
    // The plugin's lazy loader makes a missing/misplaced addon a catchable
    // per-call error naming the expected .node path — surface it instead of a
    // bare 500 so deploy problems are diagnosable from the response.
    const message = error instanceof Error ? error.message : "Unexpected error";
    json(500, { error: message });
  }
};
