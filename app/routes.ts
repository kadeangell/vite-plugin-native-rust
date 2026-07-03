import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("slow-io", "routes/slow-io.tsx"),
  route("slow-cpu", "routes/slow-cpu.tsx"),
  route("slow-cpu-rust", "routes/slow-cpu-rust.tsx"),
  route("api/hello", "routes/api.hello.ts"),
  route("static", "routes/static.tsx"),
  route("rust", "routes/rust.tsx"),
] satisfies RouteConfig;
