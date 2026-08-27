/**
 * Minimal ambient typing for the `mssql` driver (Phase 26).
 *
 * `mssql` is a real dependency (added in Wave 2) but ships no TypeScript
 * definitions, and the adapter only ever touches the driver through a narrow
 * seam — `connect()` and `request().query()`. This declares exactly that seam
 * for both `scripts/holoo-probe.ts` and
 * `src/lib/integrations/holoo/client.ts`, so neither has to model the whole
 * driver. (The injectable `HolooSqlDriver` interface in client.ts is what the
 * rest of the code actually depends on.)
 */
declare module "mssql" {
  export interface ConnectionPool {
    request(): { query<T>(sql: string): Promise<{ recordset: T[] }> };
    close(): Promise<void>;
  }

  export function connect(
    config: string | Record<string, unknown>,
  ): Promise<ConnectionPool>;
}
