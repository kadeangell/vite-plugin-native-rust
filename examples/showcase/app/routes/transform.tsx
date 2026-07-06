import { ComingSoon } from "../coming-soon";
import { DEMOS } from "../demos";

const demo = DEMOS.find((d) => d.path === "/transform")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

// Placeholder: the HTML-transform (lol_html + ammonia) demo agent replaces this
// file with the live streaming rewrite/sanitize endpoint and A/B UI.
export default function Transform() {
  return <ComingSoon demo={demo} />;
}
