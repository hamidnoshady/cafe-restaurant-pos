import { describe, expect, it } from "vitest";
import {
  PARTY_ROLES,
  buildPartyPayload,
  formStateFromParty,
  hasPartyRole,
  parsePartyRequestBody,
  partyRoles,
  primaryPartyRole,
  resetPartyForm,
  togglePartyRole,
  validatePartyForm,
  withPartyRoles,
} from "./parties";
import { partyFormHasUnsavedChanges } from "./party-drafts";

/**
 * One person, several roles.
 *
 * The café that buys its beans from a regular customer, the workshop that
 * sells to the shop it buys from: before migration 0148 the only way to record
 * either was two `parties` rows — two accounting codes, two balances and two
 * files for one human being. The set is the fix, and the invariant every layer
 * keeps is that the *primary* role (the accounting-code prefix, and what every
 * pre-0148 query reads) is a member of it.
 */

describe("partyRoles", () => {
  it("reads a set in either spelling, sorted and de-duplicated", () => {
    expect(partyRoles(["Supplier", "Customer", "Customer"])).toEqual(["Customer", "Supplier"]);
    // The storage spelling the DB column holds.
    expect(partyRoles(["supplier", "employee"])).toEqual(["Employee", "Supplier"]);
  });

  it("folds the primary role into the set", () => {
    expect(partyRoles(["Customer"], "Supplier")).toEqual(["Customer", "Supplier"]);
    expect(partyRoles(["Customer"], "Customer")).toEqual(["Customer"]);
  });

  it("answers a pre-0148 row — a scalar role and no set — with that role alone", () => {
    expect(partyRoles(null, "Supplier")).toEqual(["Supplier"]);
    expect(partyRoles([], "Employee")).toEqual(["Employee"]);
    expect(partyRoles("customer")).toEqual(["Customer"]);
  });

  it("never answers the empty set", () => {
    // A party with no role is not a party; «مشتری» is the platform's default.
    expect(partyRoles(null)).toEqual(["Customer"]);
    expect(partyRoles(["nonsense"])).toEqual(["Customer"]);
  });
});

describe("primaryPartyRole", () => {
  it("prefers the caller's choice when it is actually in the set", () => {
    expect(primaryPartyRole(["Customer", "Supplier"], "Supplier")).toBe("Supplier");
  });

  it("refuses a primary role the party does not hold", () => {
    // A code prefix naming a role the party does not have is a code nobody can
    // read back.
    expect(primaryPartyRole(["Customer", "Supplier"], "Employee")).toBe("Customer");
  });

  it("falls back to the product's own order: مشتری، کارکنان، تأمین‌کننده", () => {
    expect(primaryPartyRole(["Supplier", "Customer"])).toBe("Customer");
    expect(primaryPartyRole(["Supplier", "Employee"])).toBe("Employee");
    expect(primaryPartyRole(["Supplier"])).toBe("Supplier");
    // Whatever the order, the answer is stable — the accounting code depends on it.
    expect(primaryPartyRole(["Customer", "Supplier"])).toBe(primaryPartyRole(["Supplier", "Customer"]));
  });
});

describe("the form's role set", () => {
  it("starts a new person as a customer", () => {
    const state = resetPartyForm();
    expect(state.roles).toEqual(["Customer"]);
    expect(state.role).toBe("Customer");
  });

  it("keeps the primary role inside the set whenever the set changes", () => {
    let state = withPartyRoles(resetPartyForm(), ["Supplier"]);
    expect(state.roles).toEqual(["Supplier"]);
    expect(state.role).toBe("Supplier");

    state = withPartyRoles(state, ["Supplier", "Customer"]);
    expect(state.roles).toEqual(["Customer", "Supplier"]);
    expect(state.roles).toContain(state.role);
  });

  it("ticks and unticks a role", () => {
    let state = resetPartyForm();
    expect(hasPartyRole(state, "Supplier")).toBe(false);
    state = togglePartyRole(state, "Supplier");
    expect(state.roles).toEqual(["Customer", "Supplier"]);
    state = togglePartyRole(state, "Customer");
    expect(state.roles).toEqual(["Supplier"]);
  });

  it("refuses to untick the last role", () => {
    const state = withPartyRoles(resetPartyForm(), ["Customer"]);
    expect(togglePartyRole(state, "Customer").roles).toEqual(["Customer"]);
  });

  it("does not mutate the state it was given", () => {
    const state = resetPartyForm();
    togglePartyRole(state, "Supplier");
    expect(state.roles).toEqual(["Customer"]);
  });
});

describe("hydrating an existing party", () => {
  it("reads the whole set back", () => {
    const state = formStateFromParty({ role: "Customer", roles: ["customer", "supplier"] });
    expect(state.roles).toEqual(["Customer", "Supplier"]);
    expect(state.role).toBe("Customer");
  });

  it("hydrates a pre-0148 record from its scalar role alone", () => {
    const state = formStateFromParty({ role: "Supplier" });
    expect(state.roles).toEqual(["Supplier"]);
    expect(state.role).toBe("Supplier");
  });

  it("round-trips through the payload without losing a role", () => {
    const state = formStateFromParty({
      role: "Supplier",
      roles: ["customer", "supplier"],
      displayName: "کافه بامداد",
    });
    const payload = buildPartyPayload(state);
    expect(payload.roles).toEqual(["Customer", "Supplier"]);
    expect(payload.roles).toContain(payload.role);
    // Back through hydration: the same set, so an edit-save-edit cycle is a
    // fixed point rather than a slow demotion to one role.
    expect(formStateFromParty(payload as never).roles).toEqual(["Customer", "Supplier"]);
  });

  it("counts a role change as an unsaved change", () => {
    const baseline = resetPartyForm();
    expect(partyFormHasUnsavedChanges(baseline, baseline)).toBe(false);
    expect(partyFormHasUnsavedChanges(togglePartyRole(baseline, "Supplier"), baseline)).toBe(true);
  });
});

describe("validation", () => {
  it("accepts a person with several roles", () => {
    const state = withPartyRoles({ ...resetPartyForm(), displayName: "علی رضایی" }, [
      "Customer",
      "Supplier",
    ]);
    expect(validatePartyForm(state)).toEqual({});
  });

  it("refuses an empty role set", () => {
    const state = { ...resetPartyForm(), displayName: "علی رضایی", roles: [] };
    expect(validatePartyForm(state).roles).toBe("required");
  });

  it("refuses a primary role that is not in the set", () => {
    const state = {
      ...resetPartyForm(),
      displayName: "علی رضایی",
      role: "Employee" as const,
      roles: ["Customer" as const],
    };
    expect(validatePartyForm(state).roles).toBe("invalid_role");
  });
});

describe("the request body", () => {
  it("accepts a multi-role write", () => {
    const { input, state, errors } = parsePartyRequestBody({
      displayName: "کافه بامداد",
      role: "Supplier",
      roles: ["Customer", "Supplier"],
    });
    expect(errors).toEqual({});
    expect(input.roles).toEqual(["Customer", "Supplier"]);
    expect(state.roles).toEqual(["Customer", "Supplier"]);
    expect(state.role).toBe("Supplier");
  });

  it("derives the set from the scalar for a pre-0148 caller", () => {
    // The POS quick-add, the Holoo importer, the assistant's tools.
    const { input, state } = parsePartyRequestBody({ displayName: "علی", role: "Customer" });
    expect(input.roles).toBeUndefined();
    expect(state.roles).toEqual(["Customer"]);
  });

  it("rejects an unknown or empty role set rather than defaulting it", () => {
    expect(parsePartyRequestBody({ roles: [] }).errors.roles).toBe("role_required");
    expect(parsePartyRequestBody({ roles: ["Wizard"] }).errors.roles).toBe("invalid_role");
    for (const role of PARTY_ROLES) {
      expect(parsePartyRequestBody({ roles: [role] }).errors.roles).toBeUndefined();
    }
  });

  it("leaves the set alone on a partial write that never mentions it", () => {
    // The directory's archive toggle: one key in, one key out.
    const { input } = parsePartyRequestBody({ status: false }, { partial: true });
    expect(input.roles).toBeUndefined();
    expect(input.role).toBeUndefined();
    expect(input.status).toBe(false);
  });
});
