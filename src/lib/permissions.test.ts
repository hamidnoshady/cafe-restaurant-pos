import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  effectivePermissions,
  hasPermission,
  isAbsoluteRole,
  parseOverrides,
  roleBasePermissions,
} from "./permissions";

describe("role presets", () => {
  it("gives the owner every permission, including ones added later", () => {
    // The owner's set is a rule, not a list — so it must equal the full
    // catalogue rather than a snapshot someone has to remember to update.
    expect(roleBasePermissions("owner").sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(isAbsoluteRole("owner")).toBe(true);
  });

  it("keeps the accountant off the floor and the floor out of the books", () => {
    const accountant = new Set(roleBasePermissions("accountant"));
    expect(accountant.has(PERMISSIONS.ledgerPost)).toBe(true);
    expect(accountant.has(PERMISSIONS.ledgerClosePeriod)).toBe(true);
    expect(accountant.has(PERMISSIONS.paymentsTake)).toBe(false);
    expect(accountant.has(PERMISSIONS.ordersCreate)).toBe(false);

    const cashier = new Set(roleBasePermissions("cashier"));
    expect(cashier.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect(cashier.has(PERMISSIONS.ledgerPost)).toBe(false);
    expect(cashier.has(PERMISSIONS.accountsEdit)).toBe(false);
  });

  it("lets managers and cashiers manage the customer directory, but keeps the accountant view-only", () => {
    expect(new Set(roleBasePermissions("manager")).has(PERMISSIONS.customersManage)).toBe(true);
    expect(new Set(roleBasePermissions("cashier")).has(PERMISSIONS.customersManage)).toBe(true);
    const accountant = new Set(roleBasePermissions("accountant"));
    expect(accountant.has(PERMISSIONS.customersView)).toBe(true);
    expect(accountant.has(PERMISSIONS.customersManage)).toBe(false);
  });

  it("restricts kitchen and waiter to their own surfaces", () => {
    expect(hasPermission("kitchen", null, PERMISSIONS.kitchenView)).toBe(true);
    expect(hasPermission("kitchen", null, PERMISSIONS.paymentsTake)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.ordersCreate)).toBe(true);
    expect(hasPermission("waiter", null, PERMISSIONS.ordersVoid)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.reportsView)).toBe(false);
    expect(hasPermission("waiter", null, PERMISSIONS.customersManage)).toBe(false);
  });

  it("does not let any non-owner role manage the team by default", () => {
    for (const role of ["manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(hasPermission(role, null, PERMISSIONS.teamManage)).toBe(false);
    }
  });
});

describe("per-member overrides", () => {
  it("grants a capability the role preset does not include", () => {
    expect(hasPermission("manager", null, PERMISSIONS.ledgerPost)).toBe(false);
    expect(
      hasPermission("manager", { granted: [PERMISSIONS.ledgerPost] }, PERMISSIONS.ledgerPost),
    ).toBe(true);
  });

  it("revokes a capability the role preset does include", () => {
    expect(hasPermission("cashier", null, PERMISSIONS.ordersDiscount)).toBe(true);
    expect(
      hasPermission("cashier", { revoked: [PERMISSIONS.ordersDiscount] }, PERMISSIONS.ordersDiscount),
    ).toBe(false);
  });

  it("applies revocation after grant when a key appears in both", () => {
    const effective = effectivePermissions("cashier", {
      granted: [PERMISSIONS.ledgerPost],
      revoked: [PERMISSIONS.ledgerPost],
    });
    expect(effective.has(PERMISSIONS.ledgerPost)).toBe(false);
  });

  it("cannot reduce an owner — a business must not be able to lock itself out", () => {
    const effective = effectivePermissions("owner", {
      revoked: [PERMISSIONS.teamManage, PERMISSIONS.settingsManage],
    });
    expect(effective.has(PERMISSIONS.teamManage)).toBe(true);
    expect(hasPermission("owner", { revoked: [PERMISSIONS.teamManage] }, PERMISSIONS.teamManage)).toBe(
      true,
    );
  });

  it("ignores unknown permission keys instead of throwing", () => {
    // A stored override naming a permission a later release removed must not
    // break every request that member makes.
    const effective = effectivePermissions("cashier", {
      granted: ["ledger.timetravel"],
      revoked: ["nonexistent.thing"],
    });
    expect(effective.has(PERMISSIONS.paymentsTake)).toBe(true);
    expect([...effective].every((p) => (ALL_PERMISSIONS as string[]).includes(p))).toBe(true);
  });

  it("leaves the preset untouched — effectivePermissions must not mutate shared state", () => {
    effectivePermissions("cashier", { revoked: [PERMISSIONS.paymentsTake] });
    expect(roleBasePermissions("cashier")).toContain(PERMISSIONS.paymentsTake);
  });
});

describe("parseOverrides", () => {
  it("reads well-formed jsonb", () => {
    expect(parseOverrides({ granted: ["ledger.post"], revoked: ["menu.edit"] })).toEqual({
      granted: ["ledger.post"],
      revoked: ["menu.edit"],
    });
  });

  it("degrades to no override for anything unusable", () => {
    for (const value of [null, undefined, "{}", 42, [], { granted: "ledger.post" }]) {
      const parsed = parseOverrides(value);
      expect(parsed.granted ?? []).toEqual([]);
      expect(parsed.revoked ?? []).toEqual([]);
    }
  });

  it("drops non-string entries inside the arrays", () => {
    expect(parseOverrides({ granted: ["ledger.post", 7, null] })).toEqual({
      granted: ["ledger.post"],
      revoked: [],
    });
  });
});
