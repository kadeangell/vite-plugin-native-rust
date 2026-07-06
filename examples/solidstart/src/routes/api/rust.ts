import { json } from "@solidjs/router";
import { runRustDemo } from "~/lib/rust";

// API route (ssr router only — API files never reach the client build).
// Returns the same Rust results as the index page, as JSON.
export async function GET() {
  return json(await runRustDemo());
}
