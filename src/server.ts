import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

export function createPowuServer(): Server {
  return createServer((request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (path === "/healthz") {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === "/") {
      response.statusCode = 200;
      response.end(JSON.stringify({ service: "powu", status: "running" }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
}

export function startPowuServer(): Server {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createPowuServer();

  server.listen(port, host, () => {
    console.log(`powu server listening on ${host}:${port}`);
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startPowuServer();
}
