import { describe, expect, it } from "vitest";
import type { Role } from "./auth-edge";
import { ROLE_LABELS, roleLabel } from "./role-labels";
import { PIN_ROLES, PASSWORD_ROLES } from "./team";

/**
 * The system roles' labels — one copy (role-labels.ts) instead of the nine
 * per-screen maps that used to drift (the setup wizard's copy was already
 * missing «حسابدار»). What this file pins is not the Persian wording itself
 * but the invariants the screens rely on: every role the system can assign is
 * labelled, and an unknown value degrades to readable text instead of
 * `undefined`.
 */

/** Every role the type admits — the assignable set of `api/team`'s guard. */
const EVERY_ROLE: readonly Role[] = ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"];

describe("role labels", () => {
  it("labels every system role, including the ones a preset-less screen forgot", () => {
    for (const role of EVERY_ROLE) {
      expect(ROLE_LABELS[role], `ROLE_LABELS[${role}]`).toBeTruthy();
    }
    // The two labels a drifting copy lost or mixed up first.
    expect(ROLE_LABELS.accountant).toBe("حسابدار");
    expect(ROLE_LABELS.manager).not.toBe(ROLE_LABELS.owner);
  });

  it("keeps the password roles and the PIN roles labelled distinctly", () => {
    const labels = [...PASSWORD_ROLES, ...PIN_ROLES].map((role) => ROLE_LABELS[role]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("degrades an unknown or missing value to readable text, never undefined", () => {
    expect(roleLabel("platform_admin")).toBe("platform_admin");
    expect(roleLabel("")).toBe("");
    expect(roleLabel(null)).toBe("");
    expect(roleLabel(undefined)).toBe("");
  });
});
