/**
 * The canonical authorization evaluator, tested against the security properties
 * the four guards it replaced were *supposed* to have.
 *
 * Each of the first group of tests corresponds to a real hole that existed
 * before the consolidation — a deactivated member who kept working, a demoted
 * one who kept their old role, a suspended tenant that kept serving. They are
 * written as regression tests rather than as feature tests because that is what
 * they are: the behaviour they assert did not exist on ~580 endpoints.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("./db", () => ({
  query: (...args: unknown[]) => query(...args),
  // The evaluator runs its reads outside tenant scope (a guard is frequently
  // the first thing a request does); the wrapper is transparent here.
  withoutTenantScope: (_label: string, fn: () => unknown) => fn(),
}));

const { authorize, denialResponse, withAuthorizationMemo } = await import("./authorize");
const { PERMISSIONS } = await import("./permissions");
import type { SessionPayload } from "./auth-edge";

const SESSION: SessionPayload = {
  sub: "member-1",
  role: "manager",
  businessId: "biz-1",
  locationId: null,
  fullName: "علی",
};

type Row = Record<string, unknown>;

/** Stubs the membership read with one row, and the platform-identity read. */
function membership(overrides: Row = {}) {
  return {
    role: "manager",
    permissions: {},
    is_active: true,
    location_id: null,
    location_scope: "all",
    business_status: "active",
    ...overrides,
  };
}

function stub({
  member,
  platformTokenVersion,
  locations = [],
  assigned = [],
}: {
  member?: Row | null;
  platformTokenVersion?: number;
  locations?: Row[];
  assigned?: Row[];
} = {}) {
  query.mockReset();
query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM platform_users")) {
      return { rows: platformTokenVersion === undefined ? [] : [{ token_version: platformTokenVersion }] };
    }
    if (sql.includes("FROM users u")) return { rows: member === null ? [] : [member ?? membership()] };
    if (sql.includes("FROM user_locations")) return { rows: assigned };
    if (sql.includes("FROM locations")) return { rows: locations };
    return { rows: [] };
  });
}

// Block body, not a concise arrow: `mockReset()` returns the mock, and vitest
// treats a hook's return value as a teardown callback — so `() =>
// query.mockReset()` registers the mock itself as cleanup and calls it with no
// arguments after every test.
beforeEach(() => {
  query.mockReset();
});

describe("identity and membership validity", () => {
  it("denies an absent session", async () => {
    stub();
    const decision = await authorize(null, { permission: PERMISSIONS.menuView });
    expect(decision).toMatchObject({ ok: false, code: "UNAUTHENTICATED", status: 401 });
  });

  it("denies a member whose membership row is gone", async () => {
    stub({ member: null });
    expect(await authorize(SESSION, {})).toMatchObject({
      ok: false,
      code: "MEMBERSHIP_NOT_FOUND",
    });
  });

  /**
   * The headline regression. `requireRole` and `requireManager` never read
   * `is_active`, so deactivating somebody did nothing to their access on ~560
   * endpoints until their JWT expired.
   */
  it("denies a deactivated member even though their token is still valid", async () => {
    stub({ member: membership({ is_active: false }) });
    expect(await authorize(SESSION, { roles: ["manager"] })).toMatchObject({
      ok: false,
      code: "MEMBERSHIP_INACTIVE",
      status: 401,
    });
  });

  it("denies every member of a suspended business", async () => {
    stub({ member: membership({ business_status: "suspended" }) });
    expect(await authorize(SESSION, { permission: PERMISSIONS.menuView })).toMatchObject({
      ok: false,
      code: "BUSINESS_NOT_ACTIVE",
      status: 403,
    });
  });

  /**
   * `requirePermission` — the newer, supposedly stricter guard — was the one
   * that skipped this, so the password-reset kill switch worked on legacy
   * endpoints and not on modern ones.
   */
  it("denies a session whose platform identity has been revoked", async () => {
    stub({ platformTokenVersion: 9 });
    const stale = { ...SESSION, platformUserId: "pu-1", tokenVersion: 4 };
    expect(await authorize(stale, {})).toMatchObject({ ok: false, code: "SESSION_REVOKED" });
  });

  it("allows a PIN-only member, who legitimately has no platform identity", async () => {
    stub();
    const pinSession = { ...SESSION, platformUserId: null };
    expect((await authorize(pinSession, { permission: PERMISSIONS.menuView })).ok).toBe(true);
  });
});

describe("the database is the authority, not the token", () => {
  it("refuses a role the token claims but the database has revoked", async () => {
    // Token says manager; the person was demoted to cashier this morning.
    stub({ member: membership({ role: "cashier" }) });
    expect(await authorize(SESSION, { roles: ["owner", "manager"] })).toMatchObject({
      ok: false,
      code: "MISSING_ROLE",
    });
  });

  it("hands the handler the current role, not the token's stale one", async () => {
    stub({ member: membership({ role: "accountant" }) });
    const decision = await authorize(SESSION, {});
    expect(decision.ok && decision.session.role).toBe("accountant");
  });

  it("applies a member's revocation immediately", async () => {
    stub({ member: membership({ permissions: { revoked: ["payments.refund"] } }) });
    expect(await authorize(SESSION, { permission: PERMISSIONS.paymentsRefund })).toMatchObject({
      ok: false,
      code: "MISSING_PERMISSION",
      permission: "payments.refund",
    });
  });

  it("applies a member's individual grant immediately", async () => {
    stub({
      member: membership({ role: "cashier", permissions: { granted: ["reports.view"] } }),
    });
    expect((await authorize(SESSION, { permission: PERMISSIONS.reportsView })).ok).toBe(true);
  });

  it("will not let a member grant themselves an owner-only capability", async () => {
    stub({ member: membership({ permissions: { granted: ["api.manage"] } }) });
    expect(await authorize(SESSION, { permission: PERMISSIONS.apiManage })).toMatchObject({
      ok: false,
      code: "OWNER_ONLY",
    });
  });
});

describe("anyPermission", () => {
  it("allows when the member holds one of the listed keys", async () => {
    stub({ member: membership({ role: "viewer" }) });
    const decision = await authorize(SESSION, {
      anyPermission: [PERMISSIONS.teamView, PERMISSIONS.teamManage],
    });
    expect(decision.ok).toBe(true);
  });

  it("denies when the member holds none of them", async () => {
    stub({ member: membership({ role: "kitchen" }) });
    expect(
      await authorize(SESSION, { anyPermission: [PERMISSIONS.teamView, PERMISSIONS.teamManage] }),
    ).toMatchObject({ ok: false, code: "MISSING_PERMISSION" });
  });
});

describe("branch scope", () => {
  it("lets an owner act in any branch of their business", async () => {
    stub({ member: membership({ role: "owner", location_scope: "home" }), locations: [{ id: "loc-9" }] });
    expect((await authorize(SESSION, { locationId: "loc-9" })).ok).toBe(true);
  });

  it("refuses a branch outside a 'selected' member's assignment", async () => {
    stub({
      member: membership({ location_scope: "selected" }),
      locations: [{ id: "loc-9" }],
      assigned: [{ location_id: "loc-1" }],
    });
    expect(await authorize(SESSION, { locationId: "loc-9" })).toMatchObject({
      ok: false,
      code: "LOCATION_FORBIDDEN",
    });
  });

  it("allows a branch inside a 'selected' member's assignment", async () => {
    stub({
      member: membership({ location_scope: "selected" }),
      locations: [{ id: "loc-1" }],
      assigned: [{ location_id: "loc-1" }],
    });
    expect((await authorize(SESSION, { locationId: "loc-1" })).ok).toBe(true);
  });

  it("refuses a 'home' member any branch but their own", async () => {
    stub({
      member: membership({ location_scope: "home", location_id: "loc-1" }),
      locations: [{ id: "loc-2" }],
    });
    expect(await authorize(SESSION, { locationId: "loc-2" })).toMatchObject({
      ok: false,
      code: "LOCATION_FORBIDDEN",
    });
  });

  /**
   * The old fall-through granted every branch to a member with no assignment
   * and no home branch. Deny by default means the absence of a decision is the
   * narrowest answer, not the widest.
   */
  it("refuses a 'home' member with no home branch instead of granting all of them", async () => {
    stub({
      member: membership({ location_scope: "home", location_id: null }),
      locations: [{ id: "loc-1" }],
    });
    expect(await authorize(SESSION, { locationId: "loc-1" })).toMatchObject({
      ok: false,
      code: "LOCATION_FORBIDDEN",
    });
  });

  /**
   * Tenant isolation: a branch id arriving from a request body is checked
   * against the acting business before the scope rules are even consulted, so
   * another tenant's branch can never resolve.
   */
  it("refuses a branch belonging to another tenant", async () => {
    stub({ member: membership({ role: "owner" }), locations: [] });
    expect(await authorize(SESSION, { locationId: "other-tenant-branch" })).toMatchObject({
      ok: false,
      code: "LOCATION_FORBIDDEN",
    });
    // Proven by construction: the lookup is keyed on the session's business.
    const call = query.mock.calls.find(([sql]) => String(sql).includes("FROM locations"));
    expect(call?.[1]).toEqual(["other-tenant-branch", "biz-1"]);
  });
});

describe("tenant isolation of the membership read", () => {
  it("keys the membership lookup on both the member and the business", async () => {
    stub();
    await authorize(SESSION, {});
    const call = query.mock.calls.find(([sql]) => String(sql).includes("FROM users u"));
    expect(call?.[1]).toEqual(["member-1", "biz-1"]);
    expect(String(call?.[0])).toContain("u.business_id = $2");
  });
});

describe("check ordering", () => {
  it("reports the tenant being suspended rather than a missing permission", async () => {
    // A member of a suspended business who also lacks the key should be told
    // the useful thing, and should not learn anything about their permissions.
    stub({ member: membership({ role: "kitchen", business_status: "suspended" }) });
    expect(await authorize(SESSION, { permission: PERMISSIONS.ledgerPost })).toMatchObject({
      code: "BUSINESS_NOT_ACTIVE",
    });
  });
});

describe("request-scoped memoisation", () => {
  it("reads the membership once per request no matter how many guards run", async () => {
    stub();
    await withAuthorizationMemo(async () => {
      await authorize(SESSION, { permission: PERMISSIONS.menuView });
      await authorize(SESSION, { permission: PERMISSIONS.ordersCreate });
      await authorize(SESSION, {});
    });
    const reads = query.mock.calls.filter(([sql]) => String(sql).includes("FROM users u"));
    expect(reads).toHaveLength(1);
  });

  it("does not memoise across requests, so a revocation lands on the next one", async () => {
    stub();
    await withAuthorizationMemo(() => authorize(SESSION, {}));
    await withAuthorizationMemo(() => authorize(SESSION, {}));
    const reads = query.mock.calls.filter(([sql]) => String(sql).includes("FROM users u"));
    expect(reads).toHaveLength(2);
  });
});

describe("denial responses", () => {
  it("names the missing capability so the UI can localise the refusal", async () => {
    stub({ member: membership({ role: "cashier" }) });
    const decision = await authorize(SESSION, { permission: PERMISSIONS.ledgerPost });
    expect(decision.ok).toBe(false);
    const response = denialResponse(decision as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "forbidden",
      code: "MISSING_PERMISSION",
      permission: "ledger.post",
    });
  });

  it("keeps the business_suspended error string the dashboard already localises", async () => {
    stub({ member: membership({ business_status: "suspended" }) });
    const decision = await authorize(SESSION, {});
    const body = await denialResponse(decision as never).json();
    expect(body.error).toBe("business_suspended");
  });

  it("leaks nothing about the role or preset behind a refusal", async () => {
    stub({ member: membership({ role: "kitchen" }) });
    const decision = await authorize(SESSION, { roles: ["owner"] });
    const body = await denialResponse(decision as never).json();
    expect(body).toEqual({ error: "forbidden", code: "MISSING_ROLE" });
  });
});
