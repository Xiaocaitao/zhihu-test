import { Pool, type PoolConfig } from "pg";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS route_requests (
  id UUID PRIMARY KEY,
  goal TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS routes (
  id UUID PRIMARY KEY REFERENCES route_requests(id) ON DELETE CASCADE,
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function createPool(options: PoolConfig = {}): Pool {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  const hasEnvironmentConfig = Boolean(options.host ?? process.env.PGHOST);
  if (!connectionString && !hasEnvironmentConfig) {
    throw new Error("DATABASE_URL or PGHOST is required");
  }
  return new Pool({
    max: 5,
    ...options,
    ...(connectionString ? { connectionString } : {}),
  });
}

export async function ensureSchema(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(schemaSql);
}
