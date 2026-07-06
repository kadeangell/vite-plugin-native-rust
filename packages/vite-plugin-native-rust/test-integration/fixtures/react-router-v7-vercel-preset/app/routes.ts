import { type RouteConfig, index, route } from "@react-router/dev/routes";

const routes: RouteConfig = [
  index("routes/home.tsx"),
  route("rust", "routes/rust.tsx"),
  // Carries `export const config = { maxDuration: 60 }`, so the Vercel preset
  // splits it into a second server bundle. Both bundles import the native
  // crate — the two-function layout from issue #1.
  route("rust-slow", "routes/rust-slow.tsx"),
];

export default routes;
