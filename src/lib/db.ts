import { Pool } from "pg";

// Reuse the pool across Next.js dev-server hot reloads.
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForPg.pgPool = new Pool({ connectionString, max: 10 });
  }
  return globalForPg.pgPool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) {
  return getPool().query<T>(text, params as never);
}
