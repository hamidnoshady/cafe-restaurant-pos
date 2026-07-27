import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionHours,
  signSession,
  verifySession,
  type Role,
  type SessionPayload,
} from "./auth-edge";
import { query } from "./db";
import { featureForApiPath, isFeatureEnabled } from "./features";
import { hasPermission, parseOverrides, type Permission } from "./permissions";
import { businessScope, enterTenantScope, NO_SCOPE, runInTenantScope } from "./tenant-context";

// Re-exported so the ~93 route handlers that import these from "@/lib/auth"
// keep working; the definitions live in auth-edge.ts because src/middleware.ts
// needs them without dragging in the tenant context or the database pool.
export {
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionHours,
  signSession,
  verifySession,
  type Role,
  type SessionPayload,
};

/**
 * Reads and verifies the session cookie, and — since Phase 12 — establishes
 * the tenant context for the rest of the request.
 *
 * The context is set on EVERY call, including to `none` when there is no valid
 * session. That unconditional set is what makes it safe to establish the scope
 * here rather than wrapping every handler body: a request can never inherit
 * whatever business the previous request on this worker happened to be for.
 * See the header comment in src/lib/tenant-context.ts.
 *
 * Server components / route handlers only.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  enterTenantScope(
    session ? businessScope(session.businessId, session.locationId, session.sub) : NO_SCOPE,
  );

  return session;
}

/**
 * Wraps a route handler so its tenant scope survives for its *entire*
 * execution, including every query any guard or service call makes along the
 * way — not just the moment `getSession()` runs.
 *
 * `getSession()`'s own `enterTenantScope()` call (via `AsyncLocalStorage.enterWith`)
 * only reliably affects code that runs before this request's continuation is
 * next interrupted by a concurrent `AsyncLocalStorage.run()` elsewhere in the
 * process — and the background ticks in `server.ts` (rollup, backup,
 * server-sync) call `withTenant()`/`withoutTenantScope()` (`.run()`) on a timer
 * for the whole lifetime of the server. The instant one of those fires while
 * this request is in flight, `enterWith()`'s effect is lost for the rest of
 * the request: reads silently come back empty (RLS fails closed) and writes
 * throw a row-level-security violation — non-deterministically, since it
 * depends on exactly when a tick happens to interleave.
 *
 * `run()` does not have this problem — establishing the scope for a route
 * handler's whole execution here, once, up front, is what everything else
 * (`getSession()`'s later `enterTenantScope()` calls included) then correctly
 * inherits for the rest of the request, tick interleaving or not. Every route
 * handler that reaches `getSession()`, `requireRole()`, `requirePermission()`,
 * or `requireManager()` needs to be wrapped in this (or the platform
 * equivalent, `withPlatformScope` in platform-auth.ts) for that reason — see
 * docs/phases/Phase-17-Feature-Gating-Hardening.md.
 */
export function withTenantScope<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    const session = token ? await verifySession(token) : null;
    const scope = session
      ? businessScope(session.businessId, session.locationId, session.sub)
      : NO_SCOPE;
    return runInTenantScope(scope, async () => {
      // Phase 17 — feature-flag enforcement. Only checked once a session
      // exists: an unauthenticated request still gets its ordinary 401 from
      // the handler's own requireRole/requirePermission call, unchanged.
      if (session) {
        const request = args[0] as NextRequest | undefined;
        const flag = request ? featureForApiPath(request.nextUrl.pathname) : null;
        if (flag && !(await isFeatureEnabled(session.businessId, flag))) {
          return NextResponse.json({ error: "feature_disabled", flag }, { status: 403 });
        }
      }
      return handler(...args);
    });
  };
}

/** Session + role guard for API routes. Returns a response to short-circuit with, or the session. */
export async function requireRole(
  ...roles: Role[]
): Promise<{ session: SessionPayload; error: null } | { session: null; error: NextResponse }> {
  const session = await getSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (!roles.includes(session.role)) {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { session, error: null };
}

/**
 * Fine-grained guard: does this member hold `permission` right now?
 *
 * Unlike `requireRole`, this re-reads the membership from the database rather
 * than trusting the token. That costs one indexed lookup and buys three
 * things: an owner revoking a permission takes effect on the member's next
 * request instead of at their next login, deactivating a member ends their
 * session's usefulness immediately, and a suspended business stops serving
 * traffic without waiting for tokens to expire.
 */
export async function requirePermission(
  permission: Permission,
): Promise<{ session: SessionPayload; error: null } | { session: null; error: NextResponse }> {
  const session = await getSession();
  if (!session) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }

  const { rows } = await query<{
    role: Role;
    permissions: unknown;
    is_active: boolean;
    business_status: string;
  }>(
    `SELECT u.role, u.permissions, u.is_active, b.status::text AS business_status
       FROM users u
       JOIN businesses b ON b.id = u.business_id
      WHERE u.id = $1 AND u.business_id = $2`,
    [session.sub, session.businessId],
  );

  const membership = rows[0];
  if (!membership || !membership.is_active) {
    return { session: null, error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (membership.business_status !== "active") {
    return {
      session: null,
      error: NextResponse.json({ error: "business_suspended" }, { status: 403 }),
    };
  }
  if (!hasPermission(membership.role, parseOverrides(membership.permissions), permission)) {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }

  // The token's role can lag a role change; the database is the authority.
  return { session: { ...session, role: membership.role }, error: null };
}
