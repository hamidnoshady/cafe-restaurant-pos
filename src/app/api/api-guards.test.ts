/**
 * Phase 9 permission review, mechanized: every API route handler must start
 * with a session/role guard, and the back-office/financial surfaces must
 * never be reachable by floor roles (cashier/waiter/kitchen) — e.g. a Waiter
 * can never read ledger data, a Cashier can never edit the Chart of Accounts.
 *
 * This is a static scan of the route source (no DB, no HTTP): a new route
 * added without a guard, or with a widened role list on a financial surface,
 * fails here before it ever reaches review.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** Route key = path under src/app/api, e.g. "ledger/entries", "orders/[id]/pay". */
function routeKey(file: string): string {
  return dirname(relative(API_ROOT, file)).split(sep).join("/");
}

/** Routes that are deliberately session-less, and why. Anything else must guard. */
const PUBLIC_ROUTES: Record<string, string> = {
  "auth/login": "credential exchange — necessarily runs without a session",
  "auth/pin-login": "credential exchange — necessarily runs without a session",
  "auth/pin-login/roster":
    "the name-then-PIN picker's first step (Phase 20 Wave 2) — lists a business's PIN-role " +
    "employees (name/role/photo only, no PIN) before any credential has been presented",
  "auth/webauthn/login/options":
    "credential exchange (Phase 20 Wave 3) — step 1 of a biometric login, necessarily runs " +
    "without a session, the same as auth/pin-login",
  "auth/webauthn/login/verify":
    "credential exchange (Phase 20 Wave 3) — step 2 of a biometric login, necessarily runs " +
    "without a session, the same as auth/pin-login",
  "auth/logout": "only clears the caller's own session cookie",
  // Phase 23 Wave 3 — the apex host's "which business?" router. It verifies a
  // password (deliberately: email-only would make it an open account-
  // enumeration oracle) but mints no session and sets no cookie, which is the
  // whole point — a session only ever exists on a business's own origin.
  "auth/directory":
    "credential exchange — the apex directory checks a password and returns the caller's own " +
    "businesses without minting a session, so it necessarily runs without one",
  "host/resolve":
    "answers 'which business is this hostname?' — the Node-runtime half of host resolution, " +
    "asked before any tenant is known (the host is how one gets identified) and reaching only " +
    "what DNS and the TLS certificate already expose",
  "host/redirect":
    "forwards a visitor from an old (renamed) host or a pre-Phase-23 /{slug}/dashboard URL to " +
    "the host that serves that business now — reached precisely because the caller's session is " +
    "absent or belongs to another origin, so it cannot require one; reads no tenant data and " +
    "only ever emits a redirect",
  "health":
    "liveness probe — returns a static ok/timestamp and nothing else: no session, no database, " +
    "no tenant data. Both callers are unauthenticated by definition: the hosting platform's own " +
    "health check (which has no cookie to send), and the dashboard status strip asking 'is this " +
    "origin answering?' — the question navigator.onLine cannot answer",
  "setup/bootstrap": "first-run only — refuses with 409 as soon as any user exists",
  "setup/signup":
    "self-service business registration — creates the tenant a session would otherwise be scoped to; " +
    "refuses with 403 unless ALLOW_PUBLIC_SIGNUP is explicitly enabled",
  "auth/accept-invite":
    "invitation exchange — the invitee has no session and no membership of the inviting " +
    "business yet; the single-use token is the credential",
  "auth/impersonate-handoff":
    "credential exchange (Phase 23 follow-up) — the console's short-lived single-use handoff " +
    "token is the credential; the caller has no session on the business's origin yet by " +
    "definition, since the token exists precisely to mint the first one there",
  "rollup/ingest": "server-to-server — authenticated by a per-location bearer token, not a session",
  "server-sync/pull":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens), " +
    "falling back to the legacy global REMOTE_SYNC_TOKEN if ALLOW_LEGACY_SYNC_TOKEN is set; not a session",
  "server-sync/push":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens), " +
    "falling back to the legacy global REMOTE_SYNC_TOKEN if ALLOW_LEGACY_SYNC_TOKEN is set; not a session",
  "server-sync/update-check":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens) only, " +
    "deliberately no legacy REMOTE_SYNC_TOKEN fallback; not a session",
  "server-sync/update-token":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens) only, " +
    "deliberately no legacy REMOTE_SYNC_TOKEN fallback; not a session",
  // Migration 0132 — the platform's own server-to-server channel, for the same
  // reason as the sync ones: the caller is another deployment, mid-migration, with
  // no session here and no business to be a member of. The credential is a bearer
  // token issued in the super-admin console (platform_backup_tokens, stored
  // hashed). Both routes answer 404 unless the console has switched backup serving
  // on, so being listed here exposes nothing that is not already deliberately on;
  // and they read only the platform's own artifact folder, never a tenant's rows.
  "peer/backup/manifest":
    "server-to-server — authenticated by a platform backup bearer token (platform_backup_tokens), " +
    "and only while serving is enabled in the console; no session exists to require",
  "peer/backup/download": "platform backup artifact serving — see peer/backup/manifest",
  // Phase 15 — the super-admin realm's own credential exchange. Authenticates
  // against platform_admins and mints the platform cookie; necessarily runs
  // without a platform session, exactly like the tenant auth/login.
  "platform/auth/login": "platform credential exchange — necessarily runs without a session",
  "platform/auth/logout": "only clears the caller's own platform session cookie",
  // Desktop first-run pairing. Both halves are session-less by the same
  // reasoning as auth/accept-invite: a one-time code is the credential, and
  // the caller has no session in either realm yet.
  "platform/pairing/redeem":
    "one-time pairing code exchange — the caller is a freshly-installed desktop app with no " +
    "session in either realm, and the code is the credential; lives under /api/platform " +
    "because the issuing side is the console, not because it needs a platform session",
  "setup/pair":
    "first-run only — claims an existing online business on an empty install and refuses with " +
    "409 as soon as any user exists, exactly like setup/bootstrap",
  "setup/pair/test":
    "first-run only — probes whether a typed address reaches a POS server at all, so a wrong " +
    "address is separable from a wrong code before the one-time code is spent; refuses with 409 " +
    "as soon as any user exists, exactly like setup/pair itself",
  "pairing/redeem":
    "the host-neutral twin of platform/pairing/redeem, session-less for the identical reason — " +
    "it exists because middleware moves everything under /api/platform to the console's host, " +
    "and an owner now issues a desktop code from their own business origin (src/lib/pairing-redeem.ts)",
  "integrations/wordpress/ping":
    "the WordPress plugin channel — authenticated by a bearer link token plus an HMAC envelope " +
    "over timestamp, nonce and body (src/lib/integrations/plugin-link.ts), never a tenant session; " +
    "the token is what resolves the connection and therefore the business",
  "integrations/wordpress/handshake": "WordPress plugin channel — see integrations/wordpress/ping",
  "integrations/wordpress/events": "WordPress plugin channel — see integrations/wordpress/ping",
  "integrations/wordpress/jobs": "WordPress plugin channel — see integrations/wordpress/ping",
  "integrations/wordpress/jobs/ack": "WordPress plugin channel — see integrations/wordpress/ping",
  // Eshobe headless CMS revalidation: the CMS (a separate deployment) POSTs
  // a signed notice on every publish; authentication is the HMAC over the raw
  // body (`x-eshobe-signature`, eshobe-cms src/lib/renderer-webhook.ts), never
  // a tenant session — the CMS has no session here, and the route only purges
  // cache tags, no tenant data.
  "cms/revalidate": "server-to-server webhook from the Eshobe CMS — authenticated by the x-eshobe-signature HMAC, not a session",
  // Phase 34 — the MCP connector's OAuth 2.1 flow. Every one of these is
  // reached BEFORE any credential exists (that is what the flow is for), and
  // the only step that makes a decision — the owner pressing "allow" — is
  // deliberately NOT here: it lives at /api/connections/mcp/consent, behind
  // the tenant session and an owner-role guard.
  "mcp/oauth/register":
    "RFC 7591 dynamic client registration — the first call a client makes, before any owner has " +
    "been asked anything; it issues a client_id and nothing else, and a registration alone can " +
    "read no row. The tenant comes from the host, never from the body",
  "mcp/oauth/authorize":
    "the OAuth authorization endpoint — validates the request and hands the browser to the " +
    "authenticated consent page; it authorizes nothing itself and mints nothing",
  "mcp/oauth/token":
    "the OAuth token endpoint — session-less by definition; it makes no policy decisions, since " +
    "every one was recorded on the authorization code by the owner at the consent screen",
  "mcp/oauth/revoke":
    "RFC 7009 token revocation — a client handing its own token back; always answers 200, " +
    "because a truthful 'no such token' would make an unauthenticated endpoint a lookup oracle",
  "well-known/oauth-protected-resource/[[...path]]":
    "RFC 9728 discovery — read by a client before it has any credential at all; discloses only " +
    "URLs already implied by the hostname (rewritten from /.well-known/… in next.config.ts)",
  "well-known/oauth-authorization-server/[[...path]]":
    "RFC 8414 discovery — see well-known/oauth-protected-resource",
  "integrations/woocommerce/webhook/[connectionId]":
    "Phase 23 (issue #118) — WooCommerce delivers webhooks to this URL with an HMAC-SHA256 " +
    "signature authenticated against the connection's webhook secret (webhook-ingest-service.ts), " +
    "not a tenant session; the route resolves its business from the connection id in the URL",
};


/**
 * Phase 24 — the login interstitial. Guarded by the MFA pending token
 * (see isMfaPendingGuarded), never by a session, because a session is exactly
 * what must not exist until the second factor is presented.
 */
const MFA_PENDING_ROUTES: Record<string, string> = {
  "auth/mfa/challenge":
    "sends the tenant OTP for a password login that has passed step one — the five-minute " +
    "pending token is the credential, and issuing a session first is what MFA exists to prevent",
  "auth/mfa/verify":
    "checks the tenant second factor and only then mints the session — necessarily runs while " +
    "the caller still has no session",
  "auth/mfa/enrol":
    "enrols a tenant second factor during the grace window, reached from the same interstitial " +
    "and holding the same pending token",
  "platform/auth/mfa/challenge": "the platform-admin twin of auth/mfa/challenge",
  "platform/auth/mfa/verify": "the platform-admin twin of auth/mfa/verify",
  "platform/auth/mfa/enrol": "the platform-admin twin of auth/mfa/enrol",
};

/**
 * Phase 24 Wave 5 — routes only this server's own middleware may call.
 * Guarded by the internal secret (see isInternalCallGuarded).
 */
const INTERNAL_ROUTES: Record<string, string> = {
  "internal/rate-limit":
    "the Postgres half of the rate limiter — middleware runs in the Edge runtime and cannot " +
    "reach the database, and the call is made for requests that have no session, so it " +
    "authenticates the x-internal-auth secret instead",
};

/** Routes that guard via getSession() with route-specific logic instead of requireRole. */
const SELF_GUARDING_ROUTES: Record<string, string> = {
  "auth/me": "returns the caller's own session (or null) — nothing else",
  "setup/state": "public only for needsBootstrap; full state requires owner/manager",
  "auth/businesses": "lists the caller's own memberships — any authenticated member may ask",
  "auth/switch-business":
    "re-issues the caller's own session against another of their memberships; the membership " +
    "lookup is the authorization, so no role is applicable",
  "auth/switch-location":
    "re-issues the caller's own session against another branch of their own business; the " +
    "location-access check is the authorization, so no role is applicable",
  "locations/active":
    "returns the caller's own active branch and switchable branches — every member has one, " +
    "regardless of role",
  "auth/verify-pin":
    "confirms the caller's own PIN to dismiss the client-side lock screen (Phase 20 Wave 2); " +
    "no new session is minted and no other employee's PIN is ever checked, so no role list applies",
  // Phase 15 — the super-admin console bootstraps from this: it returns the
  // caller's own platform session (or null) and nothing else.
  "platform/auth/me": "returns the caller's own platform session (or null) — nothing else",
  // Phase 24 Wave 2 — the signed-in user's own second factor. Every path reads
  // `platformUserId` off the session and never from the body, so there is no
  // shape of this route that touches another identity's enrolment; that
  // ownership *is* the authorization, exactly as for auth/businesses. It exists
  // because the /api/auth/mfa/{challenge,verify,enrol} trio authenticates on
  // the pre-session `mfa_pending` token, which someone already signed in during
  // their grace window does not have.
  "auth/mfa/self":
    "enrols / re-issues recovery codes for the caller's own identity — the session's own " +
    "platformUserId is the authorization, and no other account is reachable",
  // AI Hub Wave 1 (issue #141) — a conversation is visible only to the member
  // who started it (actor_user_id), not by role, so ai-conversations.ts's own
  // ownership filter is the authorization, the same shape as auth/businesses.
  "ai/conversations": "lists/creates only the caller's own conversations — ownership is the authorization",
  "ai/conversations/[id]": "reads/deletes only the caller's own conversation — ownership is the authorization",
  // Phase 35 Wave 3 — projects are scoped to the business by RLS and to the
  // creating member by the same ownership pattern as conversations. Notes
  // reach tenant scope through their parent project (like ai_messages through
  // ai_conversations).
  "ai/projects": "lists/creates projects for the caller's business — RLS + ownership",
  "ai/projects/[id]": "reads/updates/archives a project — RLS + ownership",
  "ai/projects/[id]/notes": "lists/adds notes to a project — RLS through parent project",
  "ai/projects/[id]/notes/[noteId]": "deletes a note — RLS through parent project",
};

/** True for the super-admin console's own routes, which use the platform guards. */
function isPlatformGuarded(src: string): boolean {
  return /requirePlatformAdmin\(/.test(src) || /requirePlatformCapability\(/.test(src);
}

/** Public API routes are session-less only because api-auth.ts authenticates a scoped key. */
function isApiKeyGuarded(src: string): boolean {
  return /withApiKeyScope\(/.test(src) && /requireApiScope\(/.test(src);
}


/**
 * The MCP endpoint is session-less for the same reason a /api/v1 route is: it
 * authenticates a scoped bearer credential of its own (Phase 34). `withMcpScope`
 * resolves the connection, establishes its tenant scope, and refuses without
 * one — so this is a guard, not an exemption.
 */
function isMcpGuarded(src: string): boolean {
  return /withMcpScope\(/.test(src);
}

/**
 * Phase 24 — the second step of a password login, guarded by the interstitial
 * MFA token rather than a session.
 *
 * These routes sit in the gap the whole feature exists to create: the password
 * has been verified, so the caller is not anonymous, but no session may be
 * minted until a second factor is presented. A session guard is therefore
 * impossible by construction — issuing one first is precisely the thing MFA
 * is meant to prevent.
 *
 * `signMfaPendingToken` mints the credential they check: a JWT carrying
 * `realm: "mfa"`, signed with the MFA realm's own derived key (jwt-secret.ts)
 * and expiring in five minutes. `verifyMfaPendingToken` refuses anything whose
 * realm claim differs, so neither a tenant nor a platform session token can be
 * replayed here, and each handler additionally pins `authRealm` to the realm
 * it belongs to — a tenant pending-token cannot drive the platform-admin
 * verify, or the reverse.
 *
 * This is a guard, not an exemption: an unauthenticated caller gets 401.
 */
function isMfaPendingGuarded(src: string): boolean {
  return /verifyMfaPendingToken\(/.test(src) && /authRealm !==/.test(src);
}

/**
 * Phase 24 Wave 5 — routes callable only by this server's own middleware.
 *
 * The Edge runtime cannot reach Postgres, so the durable rate-limit counter is
 * asked for over HTTP. That call is made *for* requests that have no session
 * (a login attempt is the entire point of the IP bucket), so no session guard
 * can apply; instead the caller proves it is our own middleware with the
 * `x-internal-auth` secret derived from JWT_SECRET (src/lib/internal-auth.ts).
 * `isInternalCall` refuses anything else with 401, so this is a guard.
 */
function isInternalCallGuarded(src: string): boolean {
  return /isInternalCall\(/.test(src);
}

/** All requireRole(...) argument lists found in a file, as role-name arrays. */
function requireRoleCalls(src: string): string[][] {
  const calls: string[][] = [];
  for (const m of src.matchAll(/requireRole\(([^)]*)\)/g)) {
    calls.push(
      m[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean),
    );
  }
  return calls;
}

const files = collectRouteFiles(API_ROOT);
const sources = new Map(files.map((f) => [routeKey(f), readFileSync(f, "utf8")]));

describe("every API route is guarded", () => {
  it("found a realistic number of routes", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const [key, src] of sources) {
    it(`${key} is guarded or explicitly public`, () => {
      if (key === "v1" || key.startsWith("v1/")) {
        expect(isApiKeyGuarded(src), `src/app/api/${key}/route.ts must authenticate a scoped API key`).toBe(true);
        return;
      }
      if (key === "mcp") {
        expect(
          isMcpGuarded(src),
          "src/app/api/mcp/route.ts must authenticate a scoped MCP connection",
        ).toBe(true);
        return;
      }
      if (PUBLIC_ROUTES[key]) return; // documented public route
      // Phase 24 — the two credentials that are neither a session nor an
      // absence of one: the interstitial MFA pending token, and the internal
      // middleware-to-server secret. Both refuse an unauthenticated caller.
      if (MFA_PENDING_ROUTES[key]) {
        expect(
          isMfaPendingGuarded(src),
          `src/app/api/${key}/route.ts must verify an MFA pending token and pin its authRealm`,
        ).toBe(true);
        return;
      }
      if (INTERNAL_ROUTES[key]) {
        expect(
          isInternalCallGuarded(src),
          `src/app/api/${key}/route.ts must authenticate the internal middleware credential`,
        ).toBe(true);
        return;
      }
      if (SELF_GUARDING_ROUTES[key]) {
        // Tenant self-guarding routes read getSession(); the platform console's
        // self-guarding route (auth/me) reads getPlatformSession() instead.
        expect(src).toMatch(/getSession\(|getPlatformSession\(/);
        return;
      }
      // Phase 15 — the super-admin console guards with requirePlatformAdmin /
      // requirePlatformCapability, the platform-realm equivalents of the
      // tenant requireRole/requirePermission guards.
      if (isPlatformGuarded(src)) return;
      // Phase 35 — `requireMember` is the fourth guard: any signed-in member,
      // for endpoints where every member acts only on their own rows and there
      // is therefore no role left to gate (notification devices, rules, inbox).
      // It is a guard, not an absence of one: it still refuses an unauthenticated
      // caller, and the per-route assertions below check that such a route scopes
      // its reads to the session's own user.
      expect(
        /requireRole\(/.test(src) ||
          /requireManager\(/.test(src) ||
          /requirePermission\(/.test(src) ||
          /requireMember\(/.test(src),
        `src/app/api/${key}/route.ts has no requireRole/requireManager/requirePermission/requireMember guard and is not in the documented public list`,
      ).toBe(true);
    });

  }

  it("every requireMember route scopes its work to the caller's own user (Phase 35)", () => {
    // `requireMember` deliberately admits every role, so the only thing keeping
    // one member out of another's notification devices is that each handler
    // passes `session.sub` down. A route that guards with requireMember and then
    // reads by anything else would be a self-service endpoint that isn't.
    const memberRoutes = [...sources].filter(([, src]) => /requireMember\(/.test(src));
    expect(memberRoutes.length, "no requireMember routes found").toBeGreaterThan(0);
    for (const [key, src] of memberRoutes) {
      // public-key is the one exception: it returns a deployment-wide value that
      // is the same for every member, so there is no per-user row to scope.
      if (key === "notifications/public-key") continue;
      // Same shape: the knowledge base is platform-maintained content — the
      // same active learning page (and, since migration 0131, the same
      // published article catalogue, search index and article detail) is the
      // right answer for every member of every business, so there is no
      // per-user row to scope to.
      if (key === "knowledge" || key.startsWith("knowledge/")) continue;
      expect(src, `src/app/api/${key}/route.ts uses requireMember but never scopes to session.sub`).toMatch(
        /session\.sub/,
      );
    }
  });

  it("the public list doesn't cover routes that no longer exist", () => {
    for (const key of [...Object.keys(PUBLIC_ROUTES), ...Object.keys(SELF_GUARDING_ROUTES)]) {
      expect(sources.has(key), `${key} is allowlisted but has no route file`).toBe(true);
    }
  });
});

describe("back-office/financial surfaces exclude floor roles", () => {
  // Everything under these prefixes is Owner/Manager-only, per the decisions
  // in Phases 6-8 (inventory admin, ledger, reports) and 9 (rollup).
  const BACK_OFFICE_PREFIXES = ["ledger/", "reports/", "staff", "setup/", "rollup/", "backup/"];
  // team/* and branches/* guard with requirePermission rather than a role
  // list — asserted separately below, so excluded from the role-list sweep.
  // ledger/fiscal-periods/[id] and ledger/fiscal-years/[id]/close (Phase 16) are the same:
  // requirePermission(PERMISSIONS.ledgerClosePeriod), which is owner+accountant by role
  // preset (see permissions.ts) — no floor role ever holds it. ledger/entries/drafts/[id]/approve
  // and ledger/entries/[id]/reverse use requirePermission(PERMISSIONS.ledgerApprove), same shape.
  // ledger/accounts/[id] (rename/reparent/archive/delete) uses requirePermission(PERMISSIONS.accountsEdit) —
  // ledger/accounts itself isn't listed here since its GET still guards with requireRole and that's
  // what this sweep checks; only its POST is permission-only. ledger/accounts/[id]/history (Phase 22
  // Wave 11, issue #160 §7.5) reads that same account's change history behind the same
  // PERMISSIONS.accountsEdit gate — same shape, same reasoning.
  const PERMISSION_GUARDED = [
    "team",
    "branches",
    "ledger/fiscal-periods/[id]",
    "ledger/fiscal-years/[id]/close",
    "ledger/entries/drafts/[id]/approve",
    "ledger/entries/[id]/reverse",
    "ledger/accounts/[id]",
    "ledger/accounts/[id]/history",
  ];
  const FLOOR_ROLES = ["cashier", "waiter", "kitchen"];

  for (const [key, src] of sources) {
    if (!BACK_OFFICE_PREFIXES.some((p) => key === p.replace(/\/$/, "") || key.startsWith(p))) continue;
    if (PUBLIC_ROUTES[key] || SELF_GUARDING_ROUTES[key]) continue; // justified above
    if (PERMISSION_GUARDED.includes(key)) continue; // requirePermission grants are checked via permissions.ts's role presets, not a role list here

    it(`${key} never grants cashier/waiter/kitchen access`, () => {
      const calls = requireRoleCalls(src);
      // setup/* routes guard via requireManager() (owner/manager) instead.
      if (calls.length === 0) {
        expect(src, `src/app/api/${key}/route.ts`).toMatch(/requireManager\(/);
        return;
      }
      for (const roles of calls) {
        for (const role of FLOOR_ROLES) {
          expect(roles, `src/app/api/${key}/route.ts grants '${role}'`).not.toContain(role);
        }
      }
    });
  }

  it("inventory admin is owner/manager-only (low-stock banner is the one cashier-readable exception)", () => {
    for (const [key, src] of sources) {
      if (!key.startsWith("inventory")) continue;
      for (const roles of requireRoleCalls(src)) {
        if (key === "inventory/low-stock") {
          expect(roles.sort()).toEqual(["cashier", "manager", "owner"]);
        } else {
          expect(roles.sort(), `src/app/api/${key}/route.ts`).toEqual(["manager", "owner"]);
        }
      }
    }
  });

  it("backup config, export and restore are Owner-only; run/status allow Owner/Manager (Phase 10/17 access decisions)", () => {
    // export (Phase 17) hands the browser literally all of a business's data —
    // a materially higher bar than "backup now", so it joins config as Owner-only
    // rather than Owner/Manager. restore (whole-database, only offered on a
    // single-business install) is at least as destructive as export, so it is
    // Owner-only for the same reason.
    const OWNER_ONLY = new Set(["backup/config", "backup/export", "backup/restore"]);
    for (const [key, src] of sources) {
      if (!key.startsWith("backup")) continue;
      const calls = requireRoleCalls(src);
      expect(calls.length, `src/app/api/${key}/route.ts has no requireRole`).toBeGreaterThan(0);
      for (const roles of calls) {
        if (OWNER_ONLY.has(key)) {
          expect(roles, `src/app/api/${key}/route.ts`).toEqual(["owner"]);
        } else {
          expect(roles.sort(), `src/app/api/${key}/route.ts`).toEqual(["manager", "owner"]);
        }
      }
    }
  });

  function assertPermissionGuarded(prefix: string, permissionConstant: string) {
    const routes = [...sources].filter(([key]) => key === prefix || key.startsWith(`${prefix}/`));
    expect(routes.length, `no routes found under ${prefix}/`).toBeGreaterThan(0);

    for (const [key, src] of routes) {
      expect(src, `src/app/api/${key}/route.ts`).toMatch(/requirePermission\(/);
      expect(src, `src/app/api/${key}/route.ts`).toMatch(new RegExp(`PERMISSIONS\\.${permissionConstant}`));
      // A role list here would bypass the per-member overrides entirely.
      expect(requireRoleCalls(src), `src/app/api/${key}/route.ts uses requireRole`).toEqual([]);
    }
  }

  it("team management is gated on the team.manage permission, which only Owner holds by preset", () => {
    assertPermissionGuarded("team", "teamManage");
  });

  it("branch management is gated on the locations.manage permission, which only Owner holds by preset", () => {
    assertPermissionGuarded("branches", "locationsManage");
  });

  it("server-sync config refuses writes on a central server (Phase 23 Wave 2)", () => {
    // A central server is what sites sync *to*; it has no peer of its own, so
    // pointing it at one would aim it at one of its own tenants. The UI hides
    // the form, but the route is the boundary — and the refusal has to come
    // before the body is read, or a malformed body would 400 first and hide
    // the real reason.
    const src = sources.get("server-sync/config");
    expect(src, "src/app/api/server-sync/config/route.ts is missing").toBeTruthy();
    expect(src!).toMatch(/deploymentRole\(\)\s*===\s*"central"/);
    expect(src!).toMatch(/"central_server"/);

    const put = src!.slice(src!.indexOf("export const PUT"));
    expect(put.indexOf('deploymentRole() === "central"')).toBeGreaterThan(-1);
    expect(put.indexOf('deploymentRole() === "central"')).toBeLessThan(put.indexOf("request.json()"));
  });

  it("cross-location rollup management is Owner-only (Phase 9 access decision)", () => {
    for (const [key, src] of sources) {
      if (!key.startsWith("rollup") || key === "rollup/ingest") continue;
      const calls = requireRoleCalls(src);
      expect(calls.length, `src/app/api/${key}/route.ts has no requireRole`).toBeGreaterThan(0);
      for (const roles of calls) {
        expect(roles, `src/app/api/${key}/route.ts`).toEqual(["owner"]);
      }
    }
  });
});
