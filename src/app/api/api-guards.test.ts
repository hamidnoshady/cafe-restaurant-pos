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
  "rollup/ingest": "server-to-server — authenticated by a per-location bearer token, not a session",
};

/** Routes that guard via getSession() with route-specific logic instead of requireRole. */
const SELF_GUARDING_ROUTES: Record<string, string> = {
  "auth/me": "returns the caller's own session (or null) — nothing else",
  "setup/state": "public only for needsBootstrap; full state requires owner/manager",
};

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
      if (PUBLIC_ROUTES[key]) return; // documented public route
      if (SELF_GUARDING_ROUTES[key]) {
        expect(src).toMatch(/getSession\(/);
        return;
      }
      expect(
        /requireRole\(/.test(src) || /requireManager\(/.test(src),
        `src/app/api/${key}/route.ts has no requireRole/requireManager guard and is not in the documented public list`,
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
  const BACK_OFFICE_PREFIXES = ["ledger/", "reports/", "staff", "setup/", "rollup/"];
  const FLOOR_ROLES = ["cashier", "waiter", "kitchen"];

  for (const [key, src] of sources) {
    if (!BACK_OFFICE_PREFIXES.some((p) => key === p.replace(/\/$/, "") || key.startsWith(p))) continue;
    if (PUBLIC_ROUTES[key] || SELF_GUARDING_ROUTES[key]) continue; // justified above

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
