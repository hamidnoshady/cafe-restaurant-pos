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
  "auth/logout": "only clears the caller's own session cookie",
  "setup/bootstrap": "first-run only — refuses with 409 as soon as any user exists",
  "setup/signup":
    "self-service business registration — creates the tenant a session would otherwise be scoped to; " +
    "refuses with 403 unless ALLOW_PUBLIC_SIGNUP is explicitly enabled",
  "auth/accept-invite":
    "invitation exchange — the invitee has no session and no membership of the inviting " +
    "business yet; the single-use token is the credential",
  "rollup/ingest": "server-to-server — authenticated by a per-location bearer token, not a session",
  "server-sync/pull":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens), " +
    "falling back to the legacy global REMOTE_SYNC_TOKEN; not a session",
  "server-sync/push":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens), " +
    "falling back to the legacy global REMOTE_SYNC_TOKEN; not a session",
  "server-sync/update-check":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens) only, " +
    "deliberately no legacy REMOTE_SYNC_TOKEN fallback; not a session",
  "server-sync/update-token":
    "server-to-server — authenticated by a per-business bearer token (server_sync_tokens) only, " +
    "deliberately no legacy REMOTE_SYNC_TOKEN fallback; not a session",
  // Phase 15 — the super-admin realm's own credential exchange. Authenticates
  // against platform_admins and mints the platform cookie; necessarily runs
  // without a platform session, exactly like the tenant auth/login.
  "platform/auth/login": "platform credential exchange — necessarily runs without a session",
  "platform/auth/logout": "only clears the caller's own platform session cookie",
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
  // Phase 15 — the super-admin console bootstraps from this: it returns the
  // caller's own platform session (or null) and nothing else.
  "platform/auth/me": "returns the caller's own platform session (or null) — nothing else",
};

/** True for the super-admin console's own routes, which use the platform guards. */
function isPlatformGuarded(src: string): boolean {
  return /requirePlatformAdmin\(/.test(src) || /requirePlatformCapability\(/.test(src);
}

/** Public API routes are session-less only because api-auth.ts authenticates a scoped key. */
function isApiKeyGuarded(src: string): boolean {
  return /withApiKeyScope\(/.test(src) && /requireApiScope\(/.test(src);
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
        expect(src, `src/app/api/${key}/route.ts must authenticate a scoped API key`).toSatisfy(isApiKeyGuarded);
        return;
      }
      if (PUBLIC_ROUTES[key]) return; // documented public route
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
      expect(
        /requireRole\(/.test(src) || /requireManager\(/.test(src) || /requirePermission\(/.test(src),
        `src/app/api/${key}/route.ts has no requireRole/requireManager/requirePermission guard and is not in the documented public list`,
      ).toBe(true);
    });

  }

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
  // what this sweep checks; only its POST is permission-only.
  const PERMISSION_GUARDED = [
    "team",
    "branches",
    "ledger/fiscal-periods/[id]",
    "ledger/fiscal-years/[id]/close",
    "ledger/entries/drafts/[id]/approve",
    "ledger/entries/[id]/reverse",
    "ledger/accounts/[id]",
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

  it("backup config and export are Owner-only; run/status allow Owner/Manager (Phase 10/17 access decisions)", () => {
    // export (Phase 17) hands the browser literally all of a business's data —
    // a materially higher bar than "backup now", so it joins config as Owner-only
    // rather than Owner/Manager.
    const OWNER_ONLY = new Set(["backup/config", "backup/export"]);
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
