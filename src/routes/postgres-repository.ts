import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RouteRecord, RouteRepository, RoutePlan, RouteRequest } from "./types.ts";

type RequestRow = {
  id: string;
  request: RouteRequest;
  status: RouteRecord["status"];
  error: string | null;
  created_at: Date;
};

export class PostgresRouteRepository implements RouteRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createRequest(input: RouteRequest) {
    const id = randomUUID();
    const result = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO route_requests (id, goal, request, status)
       VALUES ($1, $2, $3::jsonb, 'processing')
       RETURNING id, created_at`,
      [id, input.goal, JSON.stringify(input)],
    );
    return { id: result.rows[0].id, created_at: result.rows[0].created_at.toISOString() };
  }

  async savePlan(id: string, plan: RoutePlan): Promise<RouteRecord> {
    const result = await this.pool.query<RequestRow>(
      `WITH updated AS (
         UPDATE route_requests SET status = 'completed', error = NULL
         WHERE id = $1
         RETURNING id, request, status, error, created_at
       )
       INSERT INTO routes (id, plan) VALUES ($1, $2::jsonb)
       RETURNING (SELECT id FROM updated) AS id,
                 (SELECT request FROM updated) AS request,
                 (SELECT status FROM updated) AS status,
                 (SELECT error FROM updated) AS error,
                 (SELECT created_at FROM updated) AS created_at`,
      [id, JSON.stringify(plan)],
    );
    return toRouteRecord(result.rows[0], plan);
  }

  async failRequest(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE route_requests SET status = 'failed', error = $2 WHERE id = $1`,
      [id, message.slice(0, 1000)],
    );
  }

  async get(id: string): Promise<RouteRecord | null> {
    const result = await this.pool.query<RequestRow & { plan: RoutePlan | null }>(
      `SELECT r.id, r.request, r.status, r.error, r.created_at, routes.plan
       FROM route_requests r
       LEFT JOIN routes ON routes.id = r.id
       WHERE r.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toRouteRecord(row, row.plan ?? undefined) : null;
  }
}

function toRouteRecord(row: RequestRow, plan?: RoutePlan): RouteRecord {
  return {
    id: row.id,
    status: row.status,
    request: row.request,
    ...(plan ? { plan } : {}),
    ...(row.error ? { error: row.error } : {}),
    created_at: row.created_at.toISOString(),
  };
}
