/**
 * The permission matrix — what each built-in role may do, asserted exhaustively.
 *
 * ## Why this file is a snapshot of the whole grid rather than spot checks
 *
 * The role presets are edited whenever a feature ships: a new permission key
 * gets added to `manager` so managers keep the screen they already had, an app
 * is split into graded capabilities, a preset is "tidied". Every one of those
 * edits is a one-line diff, and a one-line diff to a preset is indistinguishable
 * — in review — from a one-line privilege escalation.
 *
 * Spot checks ("a cashier cannot refund") do not catch that, because the
 * escalation is always in the key nobody thought to spot-check. So this asserts
 * the *entire* effective set for every role. Adding a permission to a preset is
 * then a visible, deliberate change to this file, and a reviewer sees exactly
 * which role gained what.
 */
import { describe, expect, it } from "vitest";
import type { Role } from "./auth-edge";
import {
  ALL_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  isOwnerOnlyPermission,
  OWNER_ONLY_PERMISSIONS,
  PERMISSIONS,
  parseOverrides,
  roleBasePermissions,
} from "./permissions";

const ROLES: Role[] = [
  "owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen", "viewer",
];

const effective = (role: Role) => [...effectivePermissions(role, {})].sort();

describe("built-in role presets", () => {
  it("gives the owner every permission, including the non-delegable ones", () => {
    expect(effective("owner")).toEqual([...ALL_PERMISSIONS].sort());
    for (const key of OWNER_ONLY_PERMISSIONS) {
      expect(hasPermission("owner", {}, key)).toBe(true);
    }
  });

  it("gives the admin everything except the owner-only capabilities", () => {
    const admin = new Set(effective("admin"));
    for (const key of ALL_PERMISSIONS) {
      expect(admin.has(key)).toBe(!isOwnerOnlyPermission(key));
    }
    // The distinction that makes Admin worth having: full tenant
    // administration, no ownership.
    expect(hasPermission("admin", {}, PERMISSIONS.teamManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.teamPermissionsManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.locationsManage)).toBe(true);
    expect(hasPermission("admin", {}, PERMISSIONS.apiManage)).toBe(false);
  });

  it("holds the manager preset exactly", () => {
    expect(effective("manager")).toEqual([
      "backup.manage",
      "crm.configure", "crm.consent_manage", "crm.export", "crm.manage", "crm.merge", "crm.view",
      "data.export", "data.import",
      "delivery.manage",
      "growth.manage", "growth.view",
      "inventory.adjust", "inventory.view",
      "kitchen.view",
      "ledger.view",
      "loyalty.manage", "loyalty.view",
      "menu.edit", "menu.view",
      "orders.amend_closed", "orders.create", "orders.discount", "orders.void",
      "parties.manage", "parties.view",
      "payments.refund", "payments.take",
      "purchases.manage",
      "reports.export", "reports.view",
      "reservations.manage",
      "settings.manage",
      "tables.manage",
      "website.configure", "website.manage", "website.publish", "website.view",
      "workspace.approve", "workspace.contracts_manage", "workspace.manage", "workspace.view",
    ]);
  });

  it("holds the accountant preset exactly — the books, and no till or floor", () => {
    expect(effective("accountant")).toEqual([
      "accounts.edit",
      "data.export", "data.import",
      "growth.view",
      "inventory.view",
      "ledger.approve", "ledger.close_period", "ledger.post", "ledger.view",
      "menu.view",
      "parties.manage", "parties.view",
      "reports.export", "reports.view",
      "workspace.view",
    ]);
  });

  it("holds the cashier preset exactly", () => {
    expect(effective("cashier")).toEqual([
      "crm.manage",
      "delivery.manage",
      "inventory.view",
      "loyalty.view",
      "menu.view",
      "orders.create", "orders.discount",
      "parties.manage", "parties.view",
      "payments.take",
      "reservations.manage",
      "tables.manage",
      "workspace.manage", "workspace.view",
    ]);
  });

  it("holds the waiter preset exactly", () => {
    expect(effective("waiter")).toEqual([
      "menu.view",
      "orders.create",
      "reservations.manage",
      "tables.manage",
      "workspace.view",
    ]);
  });

  it("holds the kitchen preset exactly", () => {
    expect(effective("kitchen")).toEqual(["kitchen.view", "menu.view"]);
  });

  it("holds the viewer preset exactly — read-only, and deliberately no export", () => {
    expect(effective("viewer")).toEqual([
      "crm.view",
      "growth.view",
      "inventory.view",
      "kitchen.view",
      "ledger.view",
      "loyalty.view",
      "menu.view",
      "parties.view",
      "reports.view",
      "team.view",
      "website.view",
      "workspace.view",
    ]);
    // Being able to read a figure and being able to walk out with the dataset
    // behind it are different acts. An auditor gets the first, not the second.
    expect(hasPermission("viewer", {}, PERMISSIONS.reportsExport)).toBe(false);
    expect(hasPermission("viewer", {}, PERMISSIONS.crmExport)).toBe(false);
    expect(hasPermission("viewer", {}, PERMISSIONS.dataExport)).toBe(false);
  });
});

describe("privilege boundaries that must not drift", () => {
  it("keeps the till roles away from money-reversal and the books", () => {
    for (const role of ["cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, {}, PERMISSIONS.paymentsRefund)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.ordersAmendClosed)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.ledgerPost)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.backupManage)).toBe(false);
    }
  });

  it("keeps team administration off every non-administrative preset", () => {
    for (const role of ["manager", "accountant", "cashier", "waiter", "kitchen", "viewer"] as const) {
      expect(hasPermission(role, {}, PERMISSIONS.teamManage)).toBe(false);
      expect(hasPermission(role, {}, PERMISSIONS.teamPermissionsManage)).toBe(false);
    }
  });

  it("keeps API credential management owner-only through every preset", () => {
    for (const role of ROLES) {
      expect(hasPermission(role, {}, PERMISSIONS.apiManage)).toBe(role === "owner");
    }
  });

  it("never lets a non-owner preset out-grant the admin preset", () => {
    const admin = new Set(roleBasePermissions("admin"));
    for (const role of ROLES) {
      if (role === "owner" || role === "admin") continue;
      for (const key of roleBasePermissions(role)) {
        expect(admin.has(key)).toBe(true);
      }
    }
  });
});

describe("backward compatibility with the roles that existed before the refactor", () => {
  /**
   * The refactor split several role-only gates into graded permission keys.
   * Splitting a gate must never be the thing that takes access away, so these
   * assert that each legacy role still holds a key for every area it could
   * already reach.
   */
  it("keeps the manager's website access after the role gate became four keys", () => {
    // Was requireRole("owner", "manager") on all 26 /api/cms/website/* guards.
    expect(hasPermission("manager", {}, PERMISSIONS.websiteView)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.websiteManage)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.websitePublish)).toBe(true);
    expect(hasPermission("manager", {}, PERMISSIONS.websiteConfigure)).toBe(true);
  });

  it("keeps the growth reads the accountant and cashier already had", () => {
    // Deliberately two capability pairs, not one. `/api/growth/customers` was
    // owner/manager/accountant and the loyalty lookups were
    // owner/manager/cashier; collapsing both into a single `growth.view` would
    // have handed each of them the other's screens.
    // /api/growth/accounting and /api/growth/customers were open to accountants.
    expect(hasPermission("accountant", {}, PERMISSIONS.growthView)).toBe(true);
    // The loyalty lookups the till uses were open to cashiers.
    expect(hasPermission("cashier", {}, PERMISSIONS.growthView)).toBe(false);
    expect(hasPermission("cashier", {}, PERMISSIONS.loyaltyView)).toBe(true);
    expect(hasPermission("accountant", {}, PERMISSIONS.loyaltyView)).toBe(false);
    // Neither could run a campaign or grant store credit, and still cannot.
    expect(hasPermission("accountant", {}, PERMISSIONS.growthManage)).toBe(false);
    expect(hasPermission("cashier", {}, PERMISSIONS.growthManage)).toBe(false);
    expect(hasPermission("cashier", {}, PERMISSIONS.loyaltyManage)).toBe(false);
    expect(hasPermission("accountant", {}, PERMISSIONS.loyaltyManage)).toBe(false);
  });
});

describe("member overrides", () => {
  it("adds a permission the role does not include", () => {
    expect(
      hasPermission("cashier", { granted: ["reports.view"] }, PERMISSIONS.reportsView),
    ).toBe(true);
  });

  it("removes a permission the role does include", () => {
    expect(
      hasPermission("cashier", { revoked: ["orders.discount"] }, PERMISSIONS.ordersDiscount),
    ).toBe(false);
  });

  it("lets revocation win when a key is both granted and revoked", () => {
    expect(
      hasPermission(
        "cashier",
        { granted: ["payments.refund"], revoked: ["payments.refund"] },
        PERMISSIONS.paymentsRefund,
      ),
    ).toBe(false);
  });

  it("refuses to delegate an owner-only permission through a member grant", () => {
    expect(hasPermission("manager", { granted: ["api.manage"] }, PERMISSIONS.apiManage)).toBe(false);
    // …and strips it at the parsing boundary too, so it never even reaches storage.
    expect(parseOverrides({ granted: ["api.manage", "reports.view"] }).granted).toEqual([
      "reports.view",
    ]);
  });

  it("cannot reduce an owner", () => {
    expect(
      hasPermission("owner", { revoked: [...ALL_PERMISSIONS] }, PERMISSIONS.teamManage),
    ).toBe(true);
  });

  it("CAN reduce an admin — the role is delegated, not absolute", () => {
    // The whole point of Admin being distinct from Owner: an owner can hand out
    // tenant administration and still carve pieces back out of it.
    expect(
      hasPermission("admin", { revoked: ["backup.manage"] }, PERMISSIONS.backupManage),
    ).toBe(false);
  });

  it("ignores permission keys it does not recognise rather than throwing", () => {
    // A stored override naming a key a later release removed must not break
    // every request that member makes.
    expect(() =>
      effectivePermissions("cashier", { granted: ["nope.gone"], revoked: ["also.gone"] }),
    ).not.toThrow();
    expect(hasPermission("cashier", { granted: ["nope.gone"] }, PERMISSIONS.menuView)).toBe(true);
  });
});
