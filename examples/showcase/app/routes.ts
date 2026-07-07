import { type RouteConfig, index, route } from "@react-router/dev/routes";

// One route per demo. Demo agents replace the four placeholder route files
// (search/images/transform/hashing) with their live A/B implementations; the
// home index links to each and the /benchmarks page aggregates their numbers.
// /health is the multi-crate smoke route and stays as-is.
export default [
  index("routes/home.tsx"),
  route("search", "routes/search.tsx"),
  route("images", "routes/images.tsx"),
  route("images/thumb", "routes/images.thumb.ts"),
  route("transform", "routes/transform.tsx"),
  route("hashing", "routes/hashing.tsx"),
  route("benchmarks", "routes/benchmarks.tsx"),
  route("health", "routes/health.tsx"),
] satisfies RouteConfig;
