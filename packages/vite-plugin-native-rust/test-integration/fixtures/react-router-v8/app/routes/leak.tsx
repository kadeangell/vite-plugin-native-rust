// Client-reachable import of a `.rs` file: `add` is used in the default
// (client-rendered) component, so the value cannot be tree-shaken out of the
// client bundle. The plugin must reject this at build time.
import { add } from "../../native/src/lib.rs";

export default function Leak() {
  return <main>{add(1, 1)}</main>;
}
