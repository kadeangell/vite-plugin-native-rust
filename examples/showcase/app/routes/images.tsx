import { ComingSoon } from "../coming-soon";
import { DEMOS } from "../demos";

const demo = DEMOS.find((d) => d.path === "/images")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

// Placeholder: the image-pipeline (image + ravif) demo agent replaces this file
// with the live resize/encode endpoint and A/B UI.
export default function Images() {
  return <ComingSoon demo={demo} />;
}
