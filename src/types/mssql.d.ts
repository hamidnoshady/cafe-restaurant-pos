/**
 * Minimal ambient typing for the `mssql` driver, used only by
 * `scripts/holoo-probe.ts` (Phase 26 Wave 1).
 *
 * Wave 1 is a no-dependency wave: `mssql` is not added to package.json until
 * Wave 2 (where it replaces this stub with the driver's own shipped types).
 * Declaring the module here lets the probe typecheck against the narrow seam
 * it actually uses — connect/query/close — without pulling the driver in.
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
