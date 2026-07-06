import { useLoaderData } from "react-router";

import { add, sumTo } from "../rust-demo.server";

// `export const config` makes the Vercel preset split this route into its own
// server bundle (build/server/nodejs_<base64url({"maxDuration":60,...})>/), so
// the build emits TWO bundles that both import the native crate — the exact
// shape from issue #1's repro.
export const config = { maxDuration: 60 };

export async function loader() {
  const total = await sumTo(200); // 20100
  const sum = add(1, 2); // 3
  return { sum, total };
}

export default function RustSlow() {
  const { sum, total } = useLoaderData<typeof loader>();
  return (
    <main>
      <pre>{`add=${sum};sumTo=${total}`}</pre>
    </main>
  );
}
