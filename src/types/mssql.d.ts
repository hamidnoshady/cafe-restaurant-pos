/**
 * Minimal ambient typing for the `mssql` driver (Phase 26).
 *
 * `mssql` is a real dependency but ships no TypeScript definitions in the
 * shape this project consumes, and the adapter only ever touches the driver
 * through a narrow seam — connection pool, request query, and transaction.
 */
declare module "mssql" {
  export class ConnectionPool {
    constructor(config: string | Record<string, unknown>);
    connect(): Promise<ConnectionPool>;
    request(): Request;
    close(): Promise<void>;
  }

  export class Transaction {
    constructor(pool: ConnectionPool);
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }

  export class Request {
    constructor(transaction?: Transaction);
    query<T>(sql: string): Promise<{ recordset: T[] }>;
  }

  export function connect(
    config: string | Record<string, unknown>,
  ): Promise<ConnectionPool>;
}
