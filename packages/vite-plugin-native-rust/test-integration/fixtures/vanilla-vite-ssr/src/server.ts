// The one server module that imports the native crate. Its render() output is
// the fixed string the integration tests assert against.
import { add, sumTo } from "../native/src/lib.rs";

export async function render(): Promise<string> {
  const sum = add(40, 2); // 42
  const total = await sumTo(100); // 0 + 1 + ... + 100 = 5050
  return `add=${sum};sumTo=${total}`;
}

export const EXPECTED = "add=42;sumTo=5050";
