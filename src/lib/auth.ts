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
import { query, withoutTenantScope } from "./db";
import { sessionStatus } from "./employee";
import { featureForApiPath, isFeatureEnabled } from "./features";
import { isModuleEnabled } from "./industry-guard";
import { moduleForApiPath } from "./industry-profile";
import { hasPermission, parseOverrides, PERMISSIONS, type Permission } from "./permissions";
import { activeGrant } from "./platform-service";
import { platformAudit } from "./platform-auth";
import { businessScope, enterTenantScope, NO_SCOPE, runInTenantScope } from "./tenant-context";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Phase 17 security review — `imp.grantId`'s own doc comment (auth-edge.ts)
 * says it is "re-checked live on the server, never trusted alone," but
 * nothing ever actually called `activeGrant` outside its own definition:
 * ending or revoking an impersonation window stamped the grant row but the
 * already-minted tenant token kept working, completely unaffected, until its
 * own SESSION_HOURS expiry. This is what makes the revoke "kill switch"
 * (Phase 15's exit criterion) actually kill something — a session whose
 * grant is no longer live is treated exactly like an invalid token.
 */
async function checkImpersonation(session: SessionPayload | null): Promise<SessionPayload | null> {
  if (!session?.imp) return session;
  const grant = await activeGrant(session.imp.adminId, session.businessId);
  if (!grant || grant.id !== session.imp.grantId) return null;
  return session;
}

/**
 * Phase 20 Wave 2 — the counterpart of checkImpersonation for
 * `employeeSessionId`: a JWT alone is not enough to keep using a PIN login
 * once its `employee_sessions` row has been revoked or has expired, so that
 * row is re-checked live on every request rather than trusted for the
 * token's full 12-hour lifetime. Runs with `withoutTenantScope` for the same
 * structural reason `checkImpersonation`'s `activeGrant` call does: this is
 * called from `getSession()` before `enterTenantScope` has run for the
 * request, so there is no ambient tenant scope yet to run an ordinary query
 * in — see the "employee-session-auth" entry in db.ts's `withoutTenantScope`
 * doc comment.
 */
async function checkEmployeeSession(session: SessionPayload | null): Promise<SessionPayload | null> {
  if (!session?.employeeSessionId) return session;
  const sessionId = session.employeeSessionId;

  const status = await withoutTenantScope("employee-session-auth", async () => {
    const { rows } = await query<{ expires_at: Date; revoked_at: Date | null }>(
      `SELECT expires_at, revoked_at FROM employee_sessions WHERE id = $1 AND business_id = $2`,
      [sessionId, session.businessId],
    );
    if (!rows[0]) return null;
    return sessionStatus({ expiresAt: rows[0].expires_at, revokedAt: rows[0].revoked_at });
  });
  if (status !== "active") return null;

  // Best-effort activity marker for the sessions list — never blocks the request.
  void withoutTenantScope("employee-session-auth", () =>
    query(`UPDATE employee_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]),
  ).catch(() => {});

  return session;
}

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
  const session = await checkEmployeeSession(
    await checkImpersonation(token ? await verifySession(token) : null),
  );

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
      const request = args[0] as NextRequest | undefined;

      // Phase 17 — feature-flag enforcement. Only checked once a session
      // exists: an unauthenticated request still gets its ordinary 401 from
      // the handler's own requireRole/requirePermission call, unchanged.
      if (session) {
        const flag = request ? featureForApiPath(request.nextUrl.pathname) : null;
        if (flag && !(await isFeatureEnabled(session.businessId, flag))) {
          return NextResponse.json({ error: "feature_disabled", flag }, { status: 403 });
        }

        // Phase 25 — the same enforcement, keyed on the industry's module set
        // rather than a togglable flag. A feature flag is something an
        // operator turns off; a module a trade does not have is something it
        // never had, so a jewellery business asking /api/tables is refused
        // here rather than relying on the nav not linking to it.
        const module = request ? moduleForApiPath(request.nextUrl.pathname) : null;
        if (module && !(await isModuleEnabled(session.businessId, module))) {
          return NextResponse.json({ error: "module_unavailable", module }, { status: 403 });
        }
      }

      // Phase 17 security review — "every impersonated action tagged in
      // platform_audit_log" (Phase 15's stated goal) previously only covered
      // the start/end/revoke of a grant, not what was actually done with it.
      // read_only mode never reaches here for a mutating method (middleware
      // 403s it first), so this fires only for the higher-trust `full` mode —
      // exactly the case that can change a customer's data.
      if (session?.imp && request && MUTATING_METHODS.has(request.method)) {
        await platformAudit({
          adminId: session.imp.adminId,
          businessId: session.businessId,
          action: "impersonation.request",
          entity: null,
          entityId: null,
          payload: { method: request.method, path: request.nextUrl.pathname },
        });
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


/**
 * Wave 3 floor-assistant guard. It is intentionally separate from
 * requireManager: only current cashier/waiter memberships with menu-view
 * access may use the narrow, read-only assistant.
 */
export async function requireFloorAssistant(): Promise<
  { session: SessionPayload; error: null } | { session: null; error: NextResponse }
> {
  const guard = await requirePermission(PERMISSIONS.menuView);
  if (guard.error) return guard;
  if (guard.session.role !== "cashier" && guard.session.role !== "waiter") {
    return { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}
