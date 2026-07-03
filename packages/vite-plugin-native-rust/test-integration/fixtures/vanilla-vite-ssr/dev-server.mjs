// Middleware-mode Vite dev server. Each request ssr-loads the server module and
// responds with render() output. Prints `READY <port>` once listening so the
// harness knows when to start fetching. PORT comes from the environment.
import http from "node:http";

import { createServer } from "vite";

const port = Number(process.env.PORT || 5173);

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

const server = http.createServer(async (req, res) => {
  try {
    const mod = await vite.ssrLoadModule("/src/server.ts");
    const body = await mod.render();
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain");
    res.end(body);
  } catch (err) {
    vite.ssrFixStacktrace(err);
    res.statusCode = 500;
    res.end(String(err?.stack ?? err));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY ${port}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close();
    vite.close().finally(() => process.exit(0));
  });
}
