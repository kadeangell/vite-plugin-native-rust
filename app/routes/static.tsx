import { Link } from "react-router";

export function meta() {
  return [{ title: "Static route" }];
}

// Frontend-only route: no loader, no action, just static JSX.
export default function StaticPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Static route</h1>
      <p>
        This route has no loader and no action — it is a plain default-exported
        component rendering static JSX.
      </p>
      <Link to="/">Back home</Link>
    </main>
  );
}
