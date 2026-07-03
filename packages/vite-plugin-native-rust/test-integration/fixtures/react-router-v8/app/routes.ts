import { type RouteConfig, index, route } from "@react-router/dev/routes";

const routes: RouteConfig = [
  index("routes/home.tsx"),
  route("rust", "routes/rust.tsx"),
];

// The client-leak fixture route is only wired in when RR_LEAK=1 so it never
// breaks the normal build. With it, a client-reachable `.rs` import must make
// the build fail with the friendly server-side error.
if (process.env.RR_LEAK) {
  routes.push(route("leak", "routes/leak.tsx"));
}

export default routes;
