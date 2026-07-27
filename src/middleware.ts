import { NextRequest, NextResponse } from "next/server";
// Imported from auth-edge, not auth: middleware runs in the Edge runtime,
// where the tenant context (node:async_hooks) and the pg pool that @/lib/auth
// now pulls in cannot load.
import { SESSION_COOKIE, verifySession } from "@/lib/auth-edge";
import { PLATFORM_SESSION_COOKIE, verifyPlatformSession } from "@/lib/platform-auth-edge";
import { checkRateLimit, hashKey, sweepExpired, type RateLimitEntry } from "@/lib/rate-limit";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/pin-login",
  // First-run flow: /welcome bootstraps an empty install; the state endpoint
  // answers "needsBootstrap" (and nothing more) without a session.
  "/welcome",
  "/api/setup/bootstrap",
  "/api/setup/state",
  // Phase 12: self-service business registration creates the tenant a session
  // would otherwise be scoped to, so it cannot require one. Refuses with 403
  // unless ALLOW_PUBLIC_SIGNUP is set.
  "/api/setup/signup",
  // Phase 13: an invitee has no session and no membership of the inviting
  // business yet — the single-use token in the link is the credential.
  "/invite",
  "/api/auth/accept-invite",
  // Phase 9: the caller is another location's server, not a browser — the
  // route authenticates it with a per-location bearer token, not a session.
  "/api/rollup/ingest",
  // Phase 11: same shape — the caller is a peer server (café laptop <-> VPS),
  // authenticated by a bearer token (server-sync.ts's per-business hashed
  // token, or the legacy REMOTE_SYNC_TOKEN fallback), never a session. These
  // were missing from this list entirely, which meant this generic "no
  // session -> 401" branch below rejected every real call before it ever
  // reached the route handler's own token check — server-sync has been
  // completely unreachable regardless of a valid token until this fix.
  "/api/server-sync/push",
  "/api/server-sync/pull",
];

/**
 * Phase 15 — the super-admin realm's own public entrances. The platform login
 * page and its auth endpoints must be reachable without a platform session
 * (you cannot require the thing you are trying to obtain), and `auth/me`
 * self-guards (it returns null rather than 401 when signed out, so the console
 * can bootstrap). Everything else under /platform requires the platform cookie.
 */
const PLATFORM_PUBLIC_PATHS = [
  "/platform/login",
  "/api/platform/auth/login",
  "/api/platform/auth/logout",
  "/api/platform/auth/me",
];

/** Methods that change state — the ones a read-only impersonation may not use. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Phase 17 — tenant-scoped rate limiting. Three independent fixed-window
 * counters, keyed so that one business (or one runaway bearer-token client,
 * or one IP hammering a login form) can only ever exhaust its own bucket:
 *
 *  - `businessLimits`: every authenticated tenant API request, keyed by
 *    `session.businessId` (decoded from the JWT — no DB lookup needed here).
 *    This is the exit criterion itself: "one business's traffic ... can't
 *    degrade another's".
 *  - `syncTokenLimits`: the session-less, bearer-token server-to-server
 *    routes (`rollup/ingest`, `server-sync/push`, `server-sync/pull`).
 *    Middleware can't resolve a token to a business without the DB, so this
 *    keys on the token itself (hashed, so raw tokens never sit in memory as
 *    map keys) — a runaway or misconfigured sync client can only ever
 *    saturate its own bucket, not every business sharing this server.
 *  - `authIpLimits`: credential-exchange endpoints, keyed by IP, ahead of any
 *    session — the login routes have no other request-volume defence today.
 *
 * All three Maps are module-level and unbounded by nothing but `sweepExpired`
 * (called occasionally, not per-request) — the business map stays small on
 * its own (one entry per business), but the IP/token maps grow with every
 * distinct caller ever seen.
 */
const businessLimits = new Map<string, RateLimitEntry>();
const syncTokenLimits = new Map<string, RateLimitEntry>();
const authIpLimits = new Map<string, RateLimitEntry>();

const BUSINESS_API_LIMIT = 300;
const BUSINESS_API_WINDOW_MS = 60_000;
const SYNC_TOKEN_LIMIT = 60;
const SYNC_TOKEN_WINDOW_MS = 60_000;
const AUTH_IP_LIMIT = 20;
const AUTH_IP_WINDOW_MS = 60_000;

const STALE_ENTRY_MS = 5 * 60_000;
const SWEEP_EVERY_N_REQUESTS = 200;
let requestsSinceSweep = 0;

function maybeSweep(now: number) {
  requestsSinceSweep += 1;
  if (requestsSinceSweep < SWEEP_EVERY_N_REQUESTS) return;
  requestsSinceSweep = 0;
  sweepExpired(businessLimits, now, STALE_ENTRY_MS);
  sweepExpired(syncTokenLimits, now, STALE_ENTRY_MS);
  sweepExpired(authIpLimits, now, STALE_ENTRY_MS);
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function rateLimited(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
  );
}

/** Credential-exchange endpoints in both auth realms — brute-force targets with no session to key on yet. */
const AUTH_RATE_LIMITED_PATHS = ["/api/auth/login", "/api/auth/pin-login", "/api/platform/auth/login"];

/** The session-less, bearer-token server-to-server routes (see PUBLIC_PATHS below for why each is public). */
const SYNC_TOKEN_RATE_LIMITED_PATHS = ["/api/rollup/ingest", "/api/server-sync/push", "/api/server-sync/pull"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const now = Date.now();
  maybeSweep(now);

  if (AUTH_RATE_LIMITED_PATHS.includes(pathname)) {
    const result = checkRateLimit(authIpLimits, `ip:${clientIp(request)}`, AUTH_IP_LIMIT, AUTH_IP_WINDOW_MS, now);
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (SYNC_TOKEN_RATE_LIMITED_PATHS.includes(pathname)) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader ? `token:${hashKey(authHeader)}` : `ip:${clientIp(request)}`;
    const result = checkRateLimit(syncTokenLimits, key, SYNC_TOKEN_LIMIT, SYNC_TOKEN_WINDOW_MS, now);
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  // ---- Super-admin realm ---------------------------------------------------
  // A separate auth realm with its own cookie. Handled before the tenant path
  // so a platform request is never subjected to the tenant session check (and
  // vice versa) — the two realms share no session (exit criterion 4).
  if (pathname === "/platform" || pathname.startsWith("/platform/") || pathname.startsWith("/api/platform")) {
    if (PLATFORM_PUBLIC_PATHS.some((p) => pathname === p)) {
      return NextResponse.next();
    }

    // The API routes under /api/platform self-guard (requirePlatformAdmin /
    // requirePlatformCapability), so let them through and let the handler
    // return the right 401/403. The console *pages*, being browser
    // navigations, are gated here: no platform session → the login page.
    if (pathname.startsWith("/api/platform")) {
      return NextResponse.next();
    }

    const platformToken = request.cookies.get(PLATFORM_SESSION_COOKIE)?.value;
    const platformSession = platformToken ? await verifyPlatformSession(platformToken) : null;
    if (!platformSession) {
      return NextResponse.redirect(new URL("/platform/login", request.url));
    }
    return NextResponse.next();
  }

  // ---- Tenant realm --------------------------------------------------------
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Phase 17 — every authenticated tenant API request counts against its own
  // business's bucket, so one business's traffic (or a runaway offline-sync
  // client belonging to it) can't degrade another's.
  if (pathname.startsWith("/api/")) {
    const result = checkRateLimit(
      businessLimits,
      `biz:${session.businessId}`,
      BUSINESS_API_LIMIT,
      BUSINESS_API_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  // Phase 15 — read-only impersonation. When the super-admin console entered
  // this business read-only, the tenant token carries `imp.mode === 'read_only'`.
  // Reads are allowed so the operator can see what the customer sees; any
  // state-changing request is refused at the edge, before it reaches a handler.
  // The tenant guards re-check the grant is still live; this is the cheap first
  // line that makes read-only actually mean read-only across every route.
  if (
    session.imp?.mode === "read_only" &&
    pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method)
  ) {
    return NextResponse.json({ error: "impersonation_read_only" }, { status: 403 });
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:woff2|png|svg|ico)).*)"],
};
