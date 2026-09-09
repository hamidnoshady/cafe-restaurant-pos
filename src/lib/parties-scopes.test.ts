import { describe, expect, it } from "vitest";
import {
  PARTY_COLUMNS,
  PARTY_SCOPES,
  PARTY_SCOPES_DEF,
  canEditAccountingInScope,
  canSeeAccountingInScope,
  defaultRoleForScope,
  partyMatchesScope,
  partyOwnerScopeForRole,
  partyScopeFor,
  partyScopeForApp,
  roleLabelInScope,
  showsColumn,
} from "./parties-scopes";

/**
 * The per-app view of one shared record.
 *
 * These assertions are the contract the four party screens are built on, so they
 * are written as the promise each app makes: who it lists, what it shows about the
 * ledger, and — most importantly — that only one app may *write* a given role.
 * A scope that drifts (Growth growing an edit path again, the store keeping a
 * private supplier name) is exactly the bug this file exists to refuse.
 */

const byKey = new Map(PARTY_SCOPES_DEF.map((def) => [def.key, def]));
const crm = byKey.get("crm")!;
const accounting = byKey.get("accounting")!;
const accountingCustomers = byKey.get("accounting-customers")!;
const operations = byKey.get("operations")!;
const team = byKey.get("team")!;
const growth = byKey.get("growth")!;
const sales = byKey.get("sales")!;

describe("the scope list", () => {
  it("defines exactly the scopes it names", () => {
    expect(PARTY_SCOPES_DEF.map((def) => def.key)).toEqual([...PARTY_SCOPES]);
  });

  it("gives every scope an app, a role set and a place to live", () => {
    for (const def of PARTY_SCOPES_DEF) {
      expect(def.app).toBeTruthy();
      expect(def.roles.length).toBeGreaterThan(0);
      expect(def.roles).toContain(def.defaultRole);
      expect(def.href.startsWith("/dashboard/")).toBe(true);
      expect(def.label).toBeTruthy();
      // A list with no name column is not a list of parties.
      expect(def.columns).toContain("displayName");
      for (const column of def.columns) expect(PARTY_COLUMNS).toContain(column);
    }
  });

  it("falls back to the narrowest view for an unknown key", () => {
    expect(partyScopeFor("nope").key).toBe("crm");
    expect(partyScopeFor(null).key).toBe("crm");
    expect(partyScopeFor("accounting").key).toBe("accounting");
  });

  it("answers a lookup by app, including the apps that have no party view", () => {
    expect(partyScopeForApp("crm")?.key).toBe("crm");
    expect(partyScopeForApp("accounting")?.key).toBe("accounting");
    expect(partyScopeForApp("growth")?.key).toBe("growth");
    // The website app publishes posts; it has no business listing who the
    // business pays, and `null` is what stops a nav entry being invented for it.
    // (Every other app mounts a scope. The «اتصال‌های فنی» hub asks no such
    // question: it is not an app, so it is not an argument here at all.)
    expect(partyScopeForApp("website")).toBeNull();
  });
});

describe("who each app lists", () => {
  it("the CRM lists customers, the store lists suppliers, the team lists staff", () => {
    expect(crm.roles).toEqual(["Customer"]);
    expect(operations.roles).toEqual(["Supplier"]);
    expect(team.roles).toEqual(["Employee"]);
    expect(defaultRoleForScope(operations)).toBe("Supplier");
    expect(defaultRoleForScope(team)).toBe("Employee");
  });

  it("accounting is the one view that sees all three", () => {
    expect(accounting.roles).toEqual(["Customer", "Employee", "Supplier"]);
  });

  it("accounting also has a customers-only view for the customer links", () => {
    // A/R links used to open Growth's customer projection. Now they open an
    // accounting customers screen — same shared record, only customers, with
    // the ledger fields an accountant needs.
    expect(accountingCustomers.roles).toEqual(["Customer"]);
    expect(accountingCustomers.app).toBe("accounting");
    expect(accountingCustomers.href).toBe("/dashboard/ledger?tab=customers");
    expect(accountingCustomers.columns).toContain("accountingCode");
    expect(accountingCustomers.columns).toContain("balance");
  });

  it("filters a shared list to what the scope is about", () => {
    expect(partyMatchesScope(crm, "Customer")).toBe(true);
    expect(partyMatchesScope(crm, "Supplier")).toBe(false);
    expect(partyMatchesScope(accounting, "Supplier")).toBe(true);
    expect(partyMatchesScope(crm, null)).toBe(false);
    expect(partyMatchesScope(crm, undefined)).toBe(false);
  });
});

describe("the ledger's numbers, per app", () => {
  it("only Accounting edits them", () => {
    expect(canEditAccountingInScope(accounting)).toBe(true);
    expect(canEditAccountingInScope(crm)).toBe(false);
    expect(canEditAccountingInScope(operations)).toBe(false);
    expect(canEditAccountingInScope(growth)).toBe(false);
  });

  it("Growth and the till do not even see them", () => {
    expect(canSeeAccountingInScope(growth)).toBe(false);
    expect(canSeeAccountingInScope(sales)).toBe(false);
    expect(canSeeAccountingInScope(crm)).toBe(true);
    expect(canSeeAccountingInScope(operations)).toBe(true);
  });

  it("the columns agree with the rights they are drawn from", () => {
    // A scope that hides accounting must not list its column, and a read-only one
    // must not be the place a code is typed.
    for (const def of PARTY_SCOPES_DEF) {
      expect(showsColumn(def, "accountingCode")).toBe(def.accounting !== "hidden");
      if (def.accounting !== "editable") {
        expect(def.columns).not.toContain("tax");
      }
    }
  });

  it("the role column only appears where more than one role is listed", () => {
    expect(showsColumn(accounting, "role")).toBe(true);
    expect(showsColumn(crm, "role")).toBe(false);
    expect(roleLabelInScope(crm, "Customer")).toBeNull();
    expect(roleLabelInScope(accounting, "Customer")).toBeTruthy();
  });
});

describe("one owner per role", () => {
  it("links a read-only row to the app that owns it", () => {
    expect(partyOwnerScopeForRole("Customer").key).toBe("crm");
    expect(partyOwnerScopeForRole("Supplier").key).toBe("operations");
    expect(partyOwnerScopeForRole("Employee").key).toBe("team");
  });

  it("never routes an edit to a read-only view", () => {
    for (const def of PARTY_SCOPES_DEF) {
      if (!def.readOnly) continue;
      const target = partyOwnerScopeForRole(def.defaultRole);
      expect(target.readOnly).toBe(false);
      expect(target.key).not.toBe(def.key);
    }
  });
});
