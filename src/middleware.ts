import { NextRequest, NextResponse } from "next/server";
// Imported from auth-edge, not auth: middleware runs in the Edge runtime,
// where the tenant context (node:async_hooks) and the pg pool that @/lib/auth
// now pulls in cannot load.
import { SESSION_COOKIE, verifySession } from "@/lib/auth-edge";
import {
  PLATFORM_SESSION_COOKIE,
  verifyPlatformSession,
} from "@/lib/platform-auth-edge";
import {
  checkRateLimit,
  hashKey,
  sweepExpired,
  type RateLimitEntry,
} from "@/lib/rate-limit";
import { hostRoutingEnabled, parseHost, type ParsedHost } from "@/lib/host";

const PUBLIC_PATHS = [
  // The root path decides, in src/app/page.tsx, between the login page and the
  // first-run wizard — and that decision needs to happen there, because only a
  // Node-runtime page can ask the database whether the install has any users
  // yet. Gating `/` here pre-empted it with an unconditional redirect to
  // /login, which made the wizard unreachable on a fresh desktop install (the
  // Electron window opens exactly `/`). The page itself sends an authenticated
  // caller on to the dashboard, so nothing is exposed by letting it run.
  "/",
  "/login",
  "/api/auth/login",
  "/api/auth/pin-login",
  // Phase 20 Wave 3 — the biometric-login counterpart of pin-login: no
  // session exists yet either, by the same definition. Registering a new
  // authenticator (/api/auth/webauthn/register/*) is deliberately NOT here —
  // that's self-service for an already-authenticated employee, not a login
  // path, so it goes through the normal session requirement below.
  "/api/auth/webauthn/login",
  // First-run flow: /welcome bootstraps an empty install; the state endpoint
  // answers "needsBootstrap" (and nothing more) without a session.
  "/welcome",
  "/api/setup/bootstrap",
  "/api/setup/state",
  // Desktop first-run pairing: like bootstrap, it runs against an empty
  // database, so there is no session to require. The one-time code in the body
  // is the credential, and the route refuses once any user exists.
  "/api/setup/pair",
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
  // Phase 19: third-party integrations authenticate each request with a
  // bearer API key inside api-auth.ts, not with a tenant session cookie.
  // Prefix matching keeps every /api/v1/* route reachable pre-session.
  "/api/v1",
  // Phase 23: the apex host's "which business?" router. It verifies a password
  // but mints nothing — the whole point is that no session exists on the apex —
  // so like every other credential exchange it cannot require one.
  "/api/auth/directory",
  // Phase 23: "what business is this hostname?". Answers the question the Edge
  // runtime cannot (it needs Postgres), for callers that have no session yet by
  // definition: the apex router, and an old host redirecting to its new one.
  "/api/host/resolve",
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
  // Desktop pairing: the caller is a freshly-installed app with no session in
  // either realm, and the one-time code in the body is the credential — the
  // same shape as accept-invite. The handler resolves it or refuses.
  "/api/platform/pairing/redeem",
];

/**
 * Whether a path is served without a tenant session.
 *
 * A declared path matches itself and its subtree, never a path that merely
 * shares its text (`/logindecoy` is not `/login`). `"/"` is exact-only by the
 * same rule — its subtree form is `"//"`, which no real path starts with — so
 * listing it opens the root page alone, not the whole app.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** Methods that change state — the ones a read-only impersonation may not use. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Phase 17 — tenant-scoped rate limiting. Four independent fixed-window
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
 *  - `apiKeyLimits`: the session-less public API route family, keyed by a
 *    hash of its Authorization header so one integration cannot starve other
 *    businesses (or retain a raw secret in this process).
 *  - `authIpLimits`: credential-exchange endpoints, keyed by IP, ahead of any
 *    session — the login routes have no other request-volume defence today.
 *
 * All four Maps are module-level and unbounded by nothing but `sweepExpired`
 * (called occasionally, not per-request) — the business map stays small on
 * its own (one entry per business), but the IP/token maps grow with every
 * distinct caller ever seen.
 */
const businessLimits = new Map<string, RateLimitEntry>();
const syncTokenLimits = new Map<string, RateLimitEntry>();
const apiKeyLimits = new Map<string, RateLimitEntry>();
const authIpLimits = new Map<string, RateLimitEntry>();

const BUSINESS_API_LIMIT = 300;
const BUSINESS_API_WINDOW_MS = 60_000;
const SYNC_TOKEN_LIMIT = 60;
const SYNC_TOKEN_WINDOW_MS = 60_000;
const API_KEY_LIMIT = 120;
const API_KEY_WINDOW_MS = 60_000;
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
  sweepExpired(apiKeyLimits, now, STALE_ENTRY_MS);
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
    {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
    },
  );
}

/** Credential-exchange endpoints in both auth realms — brute-force targets with no session to key on yet. */
const AUTH_RATE_LIMITED_PATHS = [
  "/api/auth/login",
  "/api/auth/pin-login",
  // Phase 20 Wave 2 — precedes the PIN itself but still enumerates a
  // business's staff pre-session, so it shares the login bucket rather than
  // going unlimited.
  "/api/auth/pin-login/roster",
  // Phase 20 Wave 3 — the biometric login ceremony's two steps, same reasoning as pin-login/roster above.
  "/api/auth/webauthn/login/options",
  "/api/auth/webauthn/login/verify",
  "/api/platform/auth/login",
  // Phase 23 — the apex directory checks a password from an unauthenticated
  // public origin, so it is a brute-force target on exactly the same terms as
  // the login routes above and shares their per-IP bucket.
  "/api/auth/directory",
  // A pairing code is a 12-character credential submitted without a session,
  // and /api/setup/pair forwards one; both belong in the same per-IP bucket as
  // every other credential exchange rather than going unlimited.
  "/api/platform/pairing/redeem",
  "/api/setup/pair",
];

/** The session-less, bearer-token server-to-server routes (see PUBLIC_PATHS below for why each is public). */
const SYNC_TOKEN_RATE_LIMITED_PATHS = [
  "/api/rollup/ingest",
  "/api/server-sync/push",
  "/api/server-sync/pull",
];

/** All public API routes share one per-key bucket; this must stay prefix-based, not an exact route list. */
function isPublicApiPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

function handleRateLimits(
  request: NextRequest,
  pathname: string,
  now: number,
): NextResponse | null {
  if (AUTH_RATE_LIMITED_PATHS.includes(pathname)) {
    const result = checkRateLimit(
      authIpLimits,
      `ip:${clientIp(request)}`,
      AUTH_IP_LIMIT,
      AUTH_IP_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (SYNC_TOKEN_RATE_LIMITED_PATHS.includes(pathname)) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader
      ? `token:${hashKey(authHeader)}`
      : `ip:${clientIp(request)}`;
    const result = checkRateLimit(
      syncTokenLimits,
      key,
      SYNC_TOKEN_LIMIT,
      SYNC_TOKEN_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  if (isPublicApiPath(pathname)) {
    const authHeader = request.headers.get("authorization");
    const key = authHeader
      ? `api-key:${hashKey(authHeader)}`
      : `ip:${clientIp(request)}`;
    const result = checkRateLimit(
      apiKeyLimits,
      key,
      API_KEY_LIMIT,
      API_KEY_WINDOW_MS,
      now,
    );
    if (!result.allowed) return rateLimited(result.retryAfterMs);
  }

  return null;
}

async function handlePlatformAdmin(
  request: NextRequest,
  pathname: string,
  host: ParsedHost | null,
  rootDomain: string,
): Promise<NextResponse | null> {
  if (
    pathname === "/platform" ||
    pathname.startsWith("/platform/") ||
    pathname.startsWith("/api/platform")
  ) {
    // Phase 23: the console lives on admin.{root} and nowhere else. Serving it
    // from a tenant's origin would put the super-admin realm inside that
    // tenant's browser origin — the exact sharing this wave removes — so the
    // request is moved to the console's own host rather than answered here.
    if (host && host.kind !== "admin") {
      const url = request.nextUrl.clone();
      url.hostname = `admin.${rootDomain}`;
      return NextResponse.redirect(url);
    }

    if (PLATFORM_PUBLIC_PATHS.some((p) => pathname === p)) {
      return NextResponse.next();
    }

    const platformToken = request.cookies.get(PLATFORM_SESSION_COOKIE)?.value;
    const platformSession = platformToken
      ? await verifyPlatformSession(platformToken)
      : null;
    if (!platformSession) {
      return NextResponse.redirect(new URL("/platform/login", request.url));
    }
    return NextResponse.next();
  }
  return null;
}

async function handleTenantAuth(request: NextRequest, pathname: string) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return {
        response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
    const loginUrl = new URL("/login", request.url);
    return { response: NextResponse.redirect(loginUrl) };
  }
  return { session };
}

/**
 * Phase 23 — the tenant isolation boundary, and the reason this wave exists.
 *
 * Before subdomain routing, every business was served from one origin and the
 * only thing separating them was a path prefix the app itself applied. One
 * `pos_session` cookie was valid for whichever business its JWT named, and all
 * tenants shared a cookie jar, a `localStorage`, a service worker, and a
 * CSP/CORS boundary. Origin is the browser's only real isolation primitive.
 *
 * Middleware runs on Edge and cannot query Postgres, so it cannot look up
 * which business a host belongs to. What it *can* do is compare the host's
 * label to the `businessSubdomain` claim minted into the session — and that is
 * enough, because the claim was written by a Node-runtime login that did have
 * the database. A mismatch means the session is not valid on this origin.
 *
 * It fails closed in every direction: an unknown host, a session with no
 * subdomain claim (minted before Phase 23), and a label that simply differs
 * all land on this host's login with the cookie cleared. Anything softer would
 * make the boundary advisory.
 */
function handleHostIsolation(
  request: NextRequest,
  pathname: string,
  host: ParsedHost,
  sessionSubdomain: string | undefined,
): NextResponse | null {
  // The console is its own realm on its own host, already handled upstream by
  // handlePlatformAdmin; the apex authenticates nothing. Neither carries a
  // tenant session, so there is nothing to compare here.
  if (host.kind === "admin" || host.kind === "apex") return null;

  if (host.kind === "business" && sessionSubdomain === host.label) return null;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "wrong_origin" }, { status: 401 });
  }

  // Clearing the cookie matters as much as the redirect: leaving it in place
  // would send the browser back into the same mismatch on every navigation,
  // and the value is useless on this origin by definition.
  const response = NextResponse.redirect(new URL("/login", request.url));
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

/**
 * The transition window's bookmark bridge (Wave 4 removes it).
 *
 * `/{slug}/dashboard/**` was the old address of every dashboard page. Under
 * subdomain routing it 301s to the same path on the business's own host, so a
 * saved bookmark or a printed URL still arrives somewhere useful instead of
 * dead-ending. 301 rather than 302 because the move is permanent — the point
 * is for browsers and link-checkers to stop asking.
 */
function handleLegacyPathRedirect(
  request: NextRequest,
  pathname: string,
  rootDomain: string,
): NextResponse | null {
  const prefixed = pathname.match(/^\/([^/]+)\/dashboard(\/.*)?$/);
  if (!prefixed) return null;

  const [, label, rest] = prefixed;
  const url = request.nextUrl.clone();
  // `hostname`, not `host`: the latter includes the port, so assigning it
  // would drop `:3000` and send a local developer to a closed port.
  url.hostname = `${label}.${rootDomain}`;
  url.pathname = `/dashboard${rest ?? ""}`;
  return NextResponse.redirect(url, 301);
}

function handleDashboardUrlRewrite(
  request: NextRequest,
  pathname: string,
  businessSlug: string,
): NextResponse | null {
  if (pathname.startsWith("/api/") || !businessSlug) return null;

  const prefixed = pathname.match(/^\/([^/]+)\/dashboard(\/.*)?$/);
  if (prefixed) {
    const [, slug, rest] = prefixed;
    const url = request.nextUrl.clone();
    if (slug !== businessSlug) {
      url.pathname = `/${businessSlug}/dashboard${rest ?? ""}`;
      return NextResponse.redirect(url);
    }
    url.pathname = `/dashboard${rest ?? ""}`;
    return NextResponse.rewrite(url);
  }
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    const url = request.nextUrl.clone();
    url.pathname = `/${businessSlug}${pathname}`;
    return NextResponse.redirect(url);
  }

  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const now = Date.now();
  maybeSweep(now);

  const rateLimitResponse = handleRateLimits(request, pathname, now);
  if (rateLimitResponse) return rateLimitResponse;

  // Read once per request. `SUBDOMAIN_ROUTING` is what keeps this whole wave
  // reversible: until it is on, everything below behaves exactly as it did.
  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";
  const hostRouting = hostRoutingEnabled();
  const host = hostRouting ? parseHost(request.headers.get("host"), rootDomain) : null;

  // ---- Super-admin realm ---------------------------------------------------
  const platformResponse = await handlePlatformAdmin(request, pathname, host, rootDomain);
  if (platformResponse) return platformResponse;

  // ---- Tenant realm --------------------------------------------------------
  if (hostRouting) {
    // Ahead of the session check on purpose: an old bookmark should land on
    // the right host whether or not the visitor is signed in here, and the
    // destination host does its own authentication.
    const legacyRedirect = handleLegacyPathRedirect(request, pathname, rootDomain);
    if (legacyRedirect) return legacyRedirect;
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const authResult = await handleTenantAuth(request, pathname);
  if ("response" in authResult) return authResult.response;
  const session = authResult.session;

  if (host) {
    // ---- Origin is the tenant boundary -------------------------------------
    const isolationResponse = handleHostIsolation(request, pathname, host, session.businessSubdomain);
    if (isolationResponse) return isolationResponse;
  } else if (session.businessSlug) {
    // ---- Legacy: business slug as a path prefix ----------------------------
    const dashboardResponse = handleDashboardUrlRewrite(
      request,
      pathname,
      session.businessSlug,
    );
    if (dashboardResponse) return dashboardResponse;
  }

  // Phase 17 — every authenticated tenant API request counts against its own
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

  // Phase 15 — read-only impersonation.
  if (
    session.imp?.mode === "read_only" &&
    pathname.startsWith("/api/") &&
    MUTATING_METHODS.has(request.method)
  ) {
    return NextResponse.json(
      { error: "impersonation_read_only" },
      { status: 403 },
    );
  }

  return NextResponse.next();
}
export const config = {
  // Everything except Next internals and static assets
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:woff2|png|svg|ico)).*)",
  ],
};
