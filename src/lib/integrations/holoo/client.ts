/**
 * Phase 26 (issue #125) Wave 2 — the Holoo client: the only place in the app
 * that talks to a Holoo install.
 *
 * Two surfaces, mirroring the two Holoo exposes:
 *  - the SQL Server database (always the read path; the guarded write path in
 *    Wave 8), and
 *  - the official web service at `http://<host>:8080/TncHoloo/api/` (the
 *    preferred write path).
 *
 * The `mssql` driver is loaded with a dynamic `import()` inside the SQL client
 * factory, so an install without Holoo never loads it — and the driver is
 * reached through an injectable seam (the `HolooSqlDriverFactory`), the same
 * way `FetchLike` makes the WooCommerce client unit-testable without a server.
 *
 * Transport security is secure-by-default: SQL Server transport encryption is
 * on unless `HOLOO_ENCRYPT=false`, and TLS certificate validation is on unless
 * `HOLOO_TRUST_SERVER_CERT=true` (for self-signed on-prem certificates).
 */
import type { FetchLike } from "../woocommerce-client";

// ---------------------------------------------------------------------------
// SQL Server client
// ---------------------------------------------------------------------------

export interface HolooSqlServerConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** The narrow slice of the driver the adapter uses — injectable for tests. */
export interface HolooSqlDriver {
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

export type HolooSqlDriverFactory = (config: HolooSqlServerConfig) => Promise<HolooSqlDriver>;

/** The default factory: dynamic `import("mssql")`, read-only intent, TLS on by default. */
export const createMssqlDriver: HolooSqlDriverFactory = async (config) => {
  const mssql = await import("mssql");
  const pool = await mssql.connect({
    server: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    options: {
      // Transport encryption is ON by default and TLS certificate validation
      // is ON by default — credentials and data must not travel in cleartext.
      // An on-prem Holoo SQL Server without TLS opts out explicitly via
      // HOLOO_ENCRYPT=false; a self-signed cert opts out via
      // HOLOO_TRUST_SERVER_CERT=true. See Phase-26-Holoo-Interoperability.md.
      encrypt: process.env.HOLOO_ENCRYPT !== "false",
      trustServerCertificate: process.env.HOLOO_TRUST_SERVER_CERT === "true",
      // Reads are always read-only; a write against a read-only routing
      // target is refused rather than silently applied.
      readOnlyIntent: true,
    },
  });
  return {
    query: async <T extends Record<string, unknown>>(sql: string) => {
      const result = await pool.request().query<T>(sql);
      return result.recordset;
    },
    close: async () => pool.close(),
  };
};

export interface HolooSqlClient {
  /** Run one SELECT against Holoo. */
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  /** The raw SQL Server version string (`SELECT @@VERSION`). */
  serverVersion(): Promise<string>;
  close(): Promise<void>;
}

export function createHolooSqlClient(
  driver: HolooSqlDriver,
): HolooSqlClient {
  return {
    query: (sql) => driver.query(sql),
    serverVersion: async () => {
      const rows = await driver.query<{ v: string }>("SELECT @@VERSION AS v");
      return rows[0]?.v ?? "";
    },
    close: () => driver.close(),
  };
}

/** Convenience: build a client from config with the real mssql driver. */
export async function connectHolooSql(config: HolooSqlServerConfig): Promise<HolooSqlClient> {
  return createHolooSqlClient(await createMssqlDriver(config));
}

// ---------------------------------------------------------------------------
// Web service client
// ---------------------------------------------------------------------------

export interface HolooWebServiceConfig {
  baseUrl: string;
  database: string;
  user: string;
  password: string;
}

export class HolooWebServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface HolooWebServiceClient {
  /** Log in and return a session token, or throw HolooWebServiceError. */
  login(): Promise<string>;
  close(): Promise<void>;
}

export function holooWebServiceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * The web-service client. `fetchImpl` is injectable (the `FetchLike` shape) so
 * tests never touch the network. The login endpoint is `Login` with database
 * name + user + password; the returned token authorises subsequent calls.
 */
export function createHolooWebServiceClient(
  config: HolooWebServiceConfig,
  fetchImpl: FetchLike = (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() })),
): HolooWebServiceClient {
  return {
    login: async () => {
      const response = await fetchImpl(holooWebServiceUrl(config.baseUrl, "Login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ database: config.database, user: config.user, password: config.password }),
      });
      const json = (await response.json()) as { token?: string; message?: string };
      if (!response.ok || !json.token) {
        throw new HolooWebServiceError(json.message ?? "holoo_ws_login_failed", response.status);
      }
      return json.token;
    },
    close: async () => undefined,
  };
}
