import { ComingSoon } from "../coming-soon";
import { DEMOS } from "../demos";

const demo = DEMOS.find((d) => d.path === "/hashing")!;

export function meta() {
  return [{ title: `${demo.title} — showcase` }];
}

// Placeholder: the password-hashing (argon2) demo agent replaces this file with
// the live sync-vs-async registration demo.
export default function Hashing() {
  return <ComingSoon demo={demo} />;
}
