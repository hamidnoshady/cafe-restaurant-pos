import { Pool, type PoolClient } from "pg";
import {
  businessScope,
  getTenantScope,
  runInTenantScope,
  scopeSettings,
  type TenantScope,
} from "./tenant-context";

// Reuse the pool across Next.js dev-server hot reloads.
const globalForPg = globalThis as unknown as { pgPool?: Pool };

/**
 * Applies the current tenant scope to every connection the pool hands out.
 *
 * Phase 12: tenant isolation is enforced by Postgres RLS keyed on the
 * `app.business_id` session setting (migration 0021), so that setting has to
 * be correct on whatever connection a statement lands on. Wrapping `connect`
 * — rather than only `query` — is what makes this airtight: node-postgres
 * implements `pool.query()` in terms of `pool.connect()`, so this single hook
 * covers both the one-off `query()` helper below AND the ~30 places that check
 * out a client directly to run a transaction. None of them had to change.
 *
 * The GUCs are set on EVERY checkout, including to empty when there is no
 * scope. That is deliberate and load-bearing: a pooled connection can never
 * be reused while still carrying the previous caller's business, because the
 * next caller always overwrites it before issuing a statement.
 */
function installTenantScoping(pool: Pool): Pool {
  const rawConnect = pool.connect.bind(pool) as typeof pool.connect;

  const applyScope = async (client: PoolClient, scope: TenantScope) => {
    const { businessId, bypass } = scopeSettings(scope);
    await client.query(
      "SELECT set_config('app.business_id', $1, false), set_config('app.rls_bypass', $2, false)",
      [businessId, bypass],
    );
  };

  function scopedConnect(this: Pool, callback?: unknown): unknown {
    // Captured here, before any awaiting, so the scope is the caller's even if
    // the checkout has to queue behind a busy pool.
    const scope = getTenantScope();

    if (typeof callback === "function") {
      const cb = callback as (err?: Error, client?: PoolClient, done?: (r?: unknown) => void) => void;
      (rawConnect as (c: typeof cb) => void)((err, client, done) => {
        if (err || !client) return cb(err, client, done);
        applyScope(client, scope).then(
          () => cb(undefined, client, done),
          (scopeErr: Error) => {
            done?.(scopeErr);
            cb(scopeErr);
          },
        );
      });
      return undefined;
    }

    return (rawConnect as () => Promise<PoolClient>)().then(async (client) => {
      try {
        await applyScope(client, scope);
        return client;
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
    });
  }

  pool.connect = scopedConnect as typeof pool.connect;
  return pool;
}

export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    // Tenant-scoped work pins a connection for the length of a transaction, so
    // the pool needs a little more headroom than it did single-tenant.
    globalForPg.pgPool = installTenantScoping(new Pool({ connectionString, max: 20 }));
  }
  return globalForPg.pgPool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) {
  return getPool().query<T>(text, params as never);
}

/**
 * Run `fn` scoped to one business.
 *
 * Use this anywhere a business is known but there is no request session to
 * derive it from — the background ticks in `server.ts` (rollup, backup,
 * server-sync) iterate businesses and must scope each iteration, and the
 * token-authenticated server-to-server routes resolve their business from a
 * bearer token rather than a cookie.
 */
export async function withTenant<T>(
  businessId: string,
  fn: () => Promise<T>,
  options: { locationId?: string | null; userId?: string | null } = {},
): Promise<T> {
  return runInTenantScope(
    businessScope(businessId, options.locationId ?? null, options.userId ?? null),
    fn,
  );
}

/**
 * Run `fn` with tenant isolation deliberately stood down.
 *
 * There are exactly two legitimate reasons, and `reason` records which:
 *
 *   - **login** — resolving an email to the businesses it belongs to
 *     necessarily happens before a business has been chosen;
 *   - **platform** — the super-user realm administers every tenant by
 *     definition (Phase 15), as does the migration runner.
 *
 * Every call is a hole in the isolation boundary, so keep them few, keep them
 * short, and never let one wrap a request body that also handles tenant data.
 */
export async function withoutTenantScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return runInTenantScope({ kind: "bypass", reason }, fn);
}

/**
 * Whether RLS is actually capable of protecting anything on this connection.
 *
 * Superusers — and any role with BYPASSRLS — ignore row-level security
 * entirely, which would make every policy in migration 0021 a silent no-op
 * with no error and no log line. The stock `docker-compose.yml` and the CI
 * service both create `pos` as the database superuser, so this is the exact
 * mistake a deployment is most likely to make.
 */
export async function rlsEffective(): Promise<boolean> {
  const { rows } = await query<{ privileged: boolean }>(
    `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
  );
  return rows[0] ? !rows[0].privileged : false;
}

/**
 * Refuse to serve production traffic with tenant isolation disabled.
 *
 * Called at startup from `server.ts`. In development it warns instead, so a
 * contributor running the stock docker-compose isn't blocked — but the
 * isolation integration test always provisions an unprivileged role, so the
 * policies are proven regardless of how the local database is configured.
 */
export async function assertRlsEffective(): Promise<void> {
  if (await rlsEffective()) return;

  const message =
    "Tenant isolation is NOT enforced: the application's database role is a superuser or has " +
    "BYPASSRLS, so every row-level security policy is being ignored. Provision an unprivileged " +
    "role with `npm run db:app-role` and point DATABASE_URL at it.";

  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(`WARNING: ${message}`);
}

export type { PoolClient };
