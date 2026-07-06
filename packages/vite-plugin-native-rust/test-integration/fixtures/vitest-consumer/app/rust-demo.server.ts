// Server-only module (`.server.ts`) that reaches the native crate. Any test
// whose module graph touches this file used to die at collection because
// vitest fed the raw `.rs` to the parser — this fixture proves it no longer
// does, either through rustPlugin() (real crate) or rustTestStub (JS twin).
import { add, sumTo } from "../native/src/lib.rs";

export { add, sumTo };

/** A single stringified result so a test can assert one value. */
export async function summary(): Promise<string> {
  return `add=${add(40, 2)};sumTo=${await sumTo(100)}`;
}
