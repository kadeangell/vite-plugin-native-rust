// Astro API endpoint — served on demand from the Vercel function. Exercises
// the same server-only Rust module as the page, but returns JSON so a curl
// check does not have to parse HTML.
import type { APIRoute } from "astro";

import { add, sumTo } from "../../lib/rust.server";

export const GET: APIRoute = async () => {
  try {
    const five = add(2, 3);
    const total = await sumTo(1_000);
    return new Response(
      JSON.stringify({ add: five, sumTo: total, runtime: process.version }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    // The plugin's lazy loader makes a missing/misplaced addon a catchable
    // per-call error naming the expected .node path — surface it instead of
    // a bare 500 so deploy problems are diagnosable from the response.
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
