import { ComingSoon } from "../coming-soon";
import { DEMOS } from "../demos";

const demo = DEMOS.find((d) => d.path === "/search")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

// Placeholder: the search (tantivy) demo agent replaces this file with the
// live `/search?q=` loader and ranked-results UI.
export default function Search() {
  return <ComingSoon demo={demo} />;
}
