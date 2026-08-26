/**
 * Phase 15 — server-side platform-admin session + capability guards.
 *
 * The tenant equivalent is `src/lib/auth.ts`. This is its counterpart for the
 * super-admin realm: it reads the platform cookie, verifies the platform
 * token, and — critically — establishes a *bypass* tenant scope for the rest
 * of the request, because the console administers every business by definition
 * (the documented `withoutTenantScope('platform', …)` reason, see db.ts).
 *
 * The token primitives live in `platform-auth-edge.ts` so `src/middleware.ts`
 * can verify a session on Edge; this file adds the DB-touching parts (the
 * fresh is-still-active check, the audit writer) and re-exports the primitives
 * so route handlers only import from `@/lib/platform-auth`.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  platformSessionHours,
  signPlatformSession,
  verifyPlatformSession,
  type PlatformAdminRole,
  type PlatformSessionPayload,
} from "./platform-auth-edge";
import { platformCan, type PlatformCapability } from "./platform-admin";
import { query } from "./db";
import { enterTenantScope, runInTenantScope } from "./tenant-context";

export {
  PLATFORM_SESSION_COOKIE,
  platformSessionCookieOptions,
  platformSessionHours,
  signPlatformSession,
  verifyPlatformSession,
  type PlatformAdminRole,
  type PlatformSessionPayload,
};

/**
 * Reads and verifies the platform session, and stands tenant isolation down
 * for the rest of the request.
 *
 * The bypass is set on EVERY call — to `bypass` when there is a platform
 * session, back to `none` when there isn't — for exactly the reason
 * `getSession()` sets the tenant scope unconditionally: a pooled connection
 * must never inherit the previous request's scope. A platform request that
 * fails auth therefore falls through to `none` (fail-closed), not to whatever
 * the last caller on this worker was scoped to.
 */
export async function getPlatformSession(): Promise<PlatformSessionPayload | null> {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  const session = token ? await verifyPlatformSession(token) : null;

  enterTenantScope(
    session ? { kind: "bypass", reason: "platform" } : { kind: "none" },
  );

  return session;
}

/**
 * Wraps a route handler so the bypass scope survives for its *entire*
 * execution, not just the moment `getPlatformSession()` runs.
 *
 * See the matching comment on `withTenantScope` in auth.ts for the full
 * explanation: `enterTenantScope()`'s `AsyncLocalStorage.enterWith()` call
 * only reliably persists until the next concurrent `AsyncLocalStorage.run()`
 * anywhere in the process — and `server.ts`'s background ticks call exactly
 * that, on a timer, for the server's whole lifetime. Establishing the scope
 * here with `run()`, once, up front, is what survives tick interleaving.
 */
export function withPlatformScope<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const store = await cookies();
    const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
    const session = token ? await verifyPlatformSession(token) : null;
    const scope = session
      ? ({ kind: "bypass", reason: "platform" } as const)
      : ({ kind: "none" } as const);
    return runInTenantScope(scope, () => handler(...args));
  };
}

/**
 * The authoritative session: the token verified AND the admin still active in
 * the database. Re-reading costs one indexed lookup and means deactivating an
 * admin ends their session's usefulness on their next request rather than at
 * token expiry — the same bargain `requirePermission` makes for tenants.
 *
 * Returns the *current* role from the database, so a role change (e.g. an owner
 * demoting an engineer to support) takes effect immediately.
 */
async function activePlatformAdmin(
  session: PlatformSessionPayload,
): Promise<PlatformSessionPayload | null> {
  const { rows } = await query<{ role: PlatformAdminRole; is_active: boolean, token_version: number }>(
    `SELECT role, is_active, token_version FROM platform_admins WHERE id = $1`,
    [session.padmin],
  );
  const admin = rows[0];
  if (!admin || !admin.is_active) return null;
  if (session.tokenVersion && admin.token_version !== session.tokenVersion) return null;
  return { ...session, role: admin.role };
}

type Guarded =
  | { session: PlatformSessionPayload; error: null }
  | { session: null; error: NextResponse };

/** Session guard: any authenticated, still-active platform admin. */
export async function requirePlatformAdmin(): Promise<Guarded> {
  const session = await getPlatformSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const fresh = await activePlatformAdmin(session);
  if (!fresh) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { session: fresh, error: null };
}

/**
 * Capability guard: an active admin whose *current* role holds `capability`.
 * This is the platform equivalent of `requirePermission` — the single check
 * every write route runs, so the danger of a surface is decided in one place
 * (`platform-admin.ts`) rather than re-argued per route.
 */
export async function requirePlatformCapability(capability: PlatformCapability): Promise<Guarded> {
  const guard = await requirePlatformAdmin();
  if (guard.error) return guard;
  if (!platformCan(guard.session.role, capability)) {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}

/**
 * Append a row to `platform_audit_log`. Every privileged cross-tenant action
 * flows through here; the console's whole accountability story is that no
 * write happens without one of these.
 *
 * Security Hardening (Phase 24): Audit log failures must be loud. If we cannot
 * record who did what, the action itself must fail rather than proceeding
 * silently.
 */
export async function platformAudit(entry: {
  adminId: string;
  businessId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO platform_audit_log
       (platform_admin_id, business_id, action, entity, entity_id, payload, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.adminId,
      entry.businessId ?? null,
      entry.action,
      entry.entity ?? null,
      entry.entityId ?? null,
      entry.payload ? JSON.stringify(entry.payload) : null,
      entry.ipAddress ?? null,
      entry.userAgent ?? null,
    ],
  ).catch((err) => {
    // Phase 24 Wave 5: "make platform-audit write failures loud instead of swallowed"
    console.error("platformAudit failed:", err);
    throw err;
  });
}
