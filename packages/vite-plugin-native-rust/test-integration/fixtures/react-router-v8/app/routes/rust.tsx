import { useLoaderData } from "react-router";

import { add, sumTo } from "../rust-demo.server";

export async function loader() {
  const total = await sumTo(100); // 5050
  const sum = add(40, 2); // 42
  return { sum, total };
}

export default function Rust() {
  const { sum, total } = useLoaderData<typeof loader>();
  // Single string child → one text node, so the output is exactly this string.
  return (
    <main>
      <pre>{`add=${sum};sumTo=${total}`}</pre>
    </main>
  );
}
