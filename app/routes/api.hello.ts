import type { Route } from "./+types/api.hello";

// Resource route: no default export, so React Router serves the loader's
// Response directly instead of rendering a component.
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";

  return Response.json({
    message: "hello",
    timestamp: new Date().toISOString(),
    uppercased: q.toUpperCase(),
  });
}
