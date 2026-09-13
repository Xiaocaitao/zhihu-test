import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { createPool, ensureSchema } from "./db/postgres.ts";
import { PiRouteAgent } from "./agent/pi-route-agent.ts";
import { PostgresRouteRepository } from "./routes/postgres-repository.ts";
import { RouteService } from "./routes/service.ts";

type PowuServerOptions = {
  routeService?: RouteService;
  readiness?: () => Promise<void>;
};

export function createPowuServer(options: PowuServerOptions = {}): Server {
  return createServer(async (request, response) => {
    const path = (request.url ?? "/").split("?", 1)[0];
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (path === "/healthz") {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === "/readyz") {
      try {
        await options.readiness?.();
        sendJson(response, 200, { ok: true });
      } catch (error) {
        console.error("readiness check failed", error);
        sendJson(response, 503, { ok: false, error: "not_ready" });
      }
      return;
    }

    if (path === "/" && request.method === "GET") {
      try {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.statusCode = 200;
        response.end(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
      } catch (error) {
        console.error("frontend unavailable", error);
        sendJson(response, 503, { ok: false, error: "frontend_unavailable" });
      }
      return;
    }

    if (path === "/api/routes" && request.method === "POST") {
      if (!options.routeService) {
        sendJson(response, 503, { ok: false, error: "route_service_unavailable" });
        return;
      }

      try {
        const body = await readJsonBody(request);
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once("aborted", abort);
        let record;
        try {
          record = await options.routeService.create(body, controller.signal);
        } finally {
          request.removeListener("aborted", abort);
        }
        sendJson(response, 201, record);
      } catch (error) {
        if (
          error instanceof ZodError ||
          error instanceof SyntaxError ||
          (error instanceof Error && ["request body is required", "request body too large"].includes(error.message))
        ) {
          const issues = error instanceof ZodError ? error.issues : undefined;
          sendJson(response, 400, { ok: false, error: "invalid_request", ...(issues ? { issues } : {}) });
          return;
        }
        console.error("route generation failed", error);
        sendJson(response, 502, { ok: false, error: "route_generation_failed" });
      }
      return;
    }

    const routeId = path.match(/^\/api\/routes\/([^/]+)$/)?.[1];
    if (routeId && request.method === "GET") {
      if (!options.routeService) {
        sendJson(response, 503, { ok: false, error: "route_service_unavailable" });
        return;
      }
      const record = await options.routeService.get(routeId);
      sendJson(response, record ? 200 : 404, record ?? { ok: false, error: "not_found" });
      return;
    }

    sendJson(response, 404, { ok: false, error: "not_found" });
  });
}

export async function startPowuServer(): Promise<Server> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const pool = createPool();
  await ensureSchema(pool);
  const repository = new PostgresRouteRepository(pool);
  const routeService = new RouteService(repository, new PiRouteAgent());
  const server = createPowuServer({
    routeService,
    readiness: async () => {
      await pool.query("SELECT 1");
    },
  });
  server.once("close", () => {
    void pool.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      console.log(`powu server listening on ${host}:${port}`);
      resolve();
    });
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startPowuServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("request body is required");
  return JSON.parse(text);
}
