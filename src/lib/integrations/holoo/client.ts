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

export interface HolooSqlConnectionOptions {
  /** SQL reads default to read-only intent; guarded direct-SQL writes opt out. */
  readOnlyIntent?: boolean;
}

/** The narrow slice of the driver the adapter uses — injectable for tests. */
export interface HolooSqlDriver {
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Execute all statements atomically. Only write-capable drivers implement this. */
  executeTransaction?(statements: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export type HolooSqlDriverFactory = (
  config: HolooSqlServerConfig,
  options?: HolooSqlConnectionOptions,
) => Promise<HolooSqlDriver>;

/** The default factory: dynamic `import("mssql")`, TLS on by default. */
export const createMssqlDriver: HolooSqlDriverFactory = async (config, options = {}) => {
  const mssql = (await import("mssql")).default;
  const pool = new mssql.ConnectionPool({
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
      // Reads are always read-only; the direct-SQL write client deliberately
      // opts out, after the Phase-26 arming/profile rails have passed.
      readOnlyIntent: options.readOnlyIntent ?? true,
    },
  });
  await pool.connect();
  return {
    query: async <T extends Record<string, unknown>>(sql: string) => {
      const result = await pool.request().query<T>(sql);
      return result.recordset;
    },
    executeTransaction: async (statements) => {
      const transaction = new mssql.Transaction(pool);
      await transaction.begin();
      try {
        for (const statement of statements) {
          const request = new mssql.Request(transaction);
          await request.query(statement);
        }
        await transaction.commit();
      } catch (err) {
        try {
          await transaction.rollback();
        } catch {
          // Preserve the original SQL error; a rollback failure is secondary.
        }
        throw err;
      }
    },
    close: async () => pool.close(),
  };
};

export interface HolooSqlClient {
  /** Run one SELECT against Holoo. */
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
  /** The raw SQL Server version string (`SELECT @@VERSION`). */
  serverVersion(): Promise<string>;
  /** Execute statements in one SQL Server transaction (guarded write path). */
  executeTransaction(statements: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export function createHolooSqlClient(driver: HolooSqlDriver): HolooSqlClient {
  return {
    query: (sql) => driver.query(sql),
    serverVersion: async () => {
      const rows = await driver.query<{ v: string }>("SELECT @@VERSION AS v");
      return rows[0]?.v ?? "";
    },
    executeTransaction: async (statements) => {
      if (!driver.executeTransaction) throw new Error("holoo_sql_driver_not_write_capable");
      await driver.executeTransaction(statements);
    },
    close: () => driver.close(),
  };
}

/** Convenience: build a read-only client from config with the real mssql driver. */
export async function connectHolooSql(config: HolooSqlServerConfig): Promise<HolooSqlClient> {
  return createHolooSqlClient(await createMssqlDriver(config, { readOnlyIntent: true }));
}

/** Convenience: build a guarded write-capable SQL client. Never use for reads. */
export async function connectHolooSqlWriter(config: HolooSqlServerConfig): Promise<HolooSqlClient> {
  return createHolooSqlClient(await createMssqlDriver(config, { readOnlyIntent: false }));
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

export interface HolooWebServiceDocument {
  /** Idempotency key from this app. */
  sourceId: string;
  occurredAt?: string | null;
  totalRial?: string | null;
  personRemoteId?: string | null;
  memo?: string | null;
  lines?: Array<Record<string, unknown>>;
  /** Direct-SQL values are also sent so the bridge can map them when required. */
  values?: (string | number | null)[];
}

export interface HolooWebServiceClient {
  /** Log in and return a session token, or throw HolooWebServiceError. */
  login(): Promise<string>;
  createSaleInvoice(document: HolooWebServiceDocument): Promise<string>;
  createReceiptPayment(document: HolooWebServiceDocument): Promise<string>;
  createPurchaseInvoice(document: HolooWebServiceDocument): Promise<string>;
  close(): Promise<void>;
}

export function holooWebServiceUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function holooDocumentNumber(json: unknown, fallback: string): string {
  if (!json || typeof json !== "object") return fallback;
  const value = json as Record<string, unknown>;
  const candidates = [
    value.documentNumber,
    value.documentNo,
    value.docNo,
    value.number,
    value.id,
    value.erpcode,
    value.ErpCode,
    (value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>).documentNumber : undefined),
    (value.data && typeof value.data === "object" ? (value.data as Record<string, unknown>).id : undefined),
  ];
  const found = candidates.find((candidate) => typeof candidate === "string" || typeof candidate === "number");
  return found === undefined ? fallback : String(found);
}

/**
 * The web-service client. `fetchImpl` is injectable (the `FetchLike` shape) so
 * tests never touch the network. The login endpoint is `Login` with database
 * name + user + password; the returned token authorises subsequent calls.
 *
 * Holoo's official service names vary slightly between releases; the profile
 * decides whether a site uses the service at all, while this client keeps the
 * call shape narrow: authenticated JSON POSTs for sale, receipt/payment, and
 * purchase documents, returning the document number Holoo assigned. The body
 * includes an idempotency key (`sourceId`) so bridge installations can de-dupe
 * safely even when Holoo itself does not expose an idempotency header.
 */
export function createHolooWebServiceClient(
  config: HolooWebServiceConfig,
  fetchImpl: FetchLike = (url, init) => fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() })),
): HolooWebServiceClient {
  let tokenPromise: Promise<string> | null = null;

  async function login(): Promise<string> {
    const response = await fetchImpl(holooWebServiceUrl(config.baseUrl, "Login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database: config.database, user: config.user, password: config.password }),
    });
    const json = (await response.json()) as { token?: string; access_token?: string; message?: string };
    const token = json.token ?? json.access_token;
    if (!response.ok || !token) {
      throw new HolooWebServiceError(json.message ?? "holoo_ws_login_failed", response.status);
    }
    return token;
  }

  async function authToken(): Promise<string> {
    tokenPromise ??= login();
    return tokenPromise;
  }

  async function postDocument(endpoint: string, document: HolooWebServiceDocument): Promise<string> {
    const token = await authToken();
    const response = await fetchImpl(holooWebServiceUrl(config.baseUrl, endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Idempotency-Key": document.sourceId,
      },
      body: JSON.stringify(document),
    });
    const json = (await response.json()) as { message?: string } & Record<string, unknown>;
    if (!response.ok) {
      throw new HolooWebServiceError(json.message ?? `holoo_ws_${endpoint}_failed`, response.status);
    }
    return holooDocumentNumber(json, `${endpoint}-${document.sourceId}`);
  }

  return {
    login: authToken,
    createSaleInvoice: (document) => postDocument("SellInvoice", document),
    createReceiptPayment: (document) => postDocument("ReceivePay", document),
    createPurchaseInvoice: (document) => postDocument("BuyInvoice", document),
    close: async () => undefined,
  };
}
