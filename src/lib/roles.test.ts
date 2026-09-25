/**
 * The role taxonomy, and the invariant that stops it being hand-copied again.
 *
 * Three client components used to carry their own `PIN_ROLES` array because
 * `team.ts` imports `node:crypto` and so cannot be imported from a
 * `"use client"` file. All three fell behind when `admin` and `viewer` were
 * added. The last test in this file fails if a fourth copy appears.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "tinyglobby";
import {
  ALL_ROLES,
  ASSIGNABLE_ROLES,
  INVITABLE_ROLES,
  PASSWORD_ROLES,
  PIN_ROLES,
  isPasswordRole,
  isPinRole,
} from "./roles";
import { ROLE_LABELS } from "./role-labels";
import { ROLE_PRESET_ROLES } from "./permissions";

describe("the role catalogue", () => {
  it("lists every role exactly once", () => {
    expect(new Set(ALL_ROLES).size).toBe(ALL_ROLES.length);
  });

  it("covers every role the permission model knows about", () => {
    // `permissions.ts` resolves a preset for each role; a role that exists
    // there but not here would be unassignable, and one that exists here but
    // not there would resolve to an empty permission set — a member who can
    // sign in and do nothing.
    expect([...ALL_ROLES].sort()).toEqual([...ROLE_PRESET_ROLES].sort());
  });

  it("has a Persian label for every role", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_LABELS[role]?.trim().length, role).toBeGreaterThan(0);
    }
  });

  it("splits every role into exactly one sign-in method", () => {
    // A role in neither list could not be created at all; a role in both would
    // make `isPasswordRole`/`isPinRole` disagree about the same person.
    for (const role of ALL_ROLES) {
      expect(isPasswordRole(role) !== isPinRole(role), role).toBe(true);
    }
    expect([...PASSWORD_ROLES, ...PIN_ROLES].sort()).toEqual([...ALL_ROLES].sort());
  });

  it("treats admin and viewer as password roles", () => {
    // An admin administers the business and a viewer is typically an external
    // accountant or auditor. Neither is a person at a shared till, so neither
    // gets a PIN — and both therefore need a platform identity.
    expect(isPasswordRole("admin")).toBe(true);
    expect(isPasswordRole("viewer")).toBe(true);
    expect(isPinRole("admin")).toBe(false);
    expect(isPinRole("viewer")).toBe(false);
  });

  it("offers every role in the catalogue for assignment", () => {
    // Who may pick a given entry is answered server-side in PATCH
    // /api/team/[id]; it is never enforced by leaving an option out of a
    // dropdown, because that is a UI opinion rather than an authorization one.
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([...ALL_ROLES].sort());
  });

  it("offers exactly the password roles for email invitation", () => {
    // An invitation is an email with a link, so it only makes sense for a role
    // that signs in with an email. `admin` and `viewer` were missing from the
    // hand-written list this replaces.
    expect([...INVITABLE_ROLES].sort()).toEqual([...PASSWORD_ROLES].sort());
    expect(INVITABLE_ROLES).toContain("admin");
    expect(INVITABLE_ROLES).toContain("viewer");
  });
});

describe("no hand-copied role lists", () => {
  it("is the only module that writes the role list out", () => {
    /*
     * The failure this prevents: a client component that cannot import
     * `team.ts` writes `const PIN_ROLES = ["cashier", "waiter", "kitchen"]`
     * with a comment pointing at the real list, and then the real list grows.
     * Import from `roles.ts` instead — it is framework-free and client-safe
     * precisely so that this is never necessary.
     */
    const offenders: string[] = [];
    const files = globSync(["src/**/*.ts", "src/**/*.tsx"], {
      ignore: ["**/*.test.ts", "**/*.test.tsx", "src/lib/roles.ts"],
    });

    /*
     * Only an exact copy of one of the taxonomy groups counts. That is the
     * distinction that matters: `const ORDER_MUTATION_ROLES = ["owner",
     * "manager", "cashier", "waiter"]` is an *audience* — a statement about who
     * may mutate an order — and it is allowed to be its own list, whereas
     * `["cashier", "waiter", "kitchen"]` is the PIN group restated and will go
     * stale the moment a role is added. (Role-gated audiences are a separate
     * concern, tracked by the `requireRole` ratchet in
     * `authorization-contract.test.ts`.)
     */
    const groups: Record<string, Set<string>> = {
      ALL_ROLES: new Set(ALL_ROLES),
      PASSWORD_ROLES: new Set(PASSWORD_ROLES),
      PIN_ROLES: new Set(PIN_ROLES),
    };

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /\b(?:const|let|var)\s+\w+[^=\n]*=\s*(\[[^\]]*\])/g,
      )) {
        const literals = [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
        if (literals.length < 2) continue;
        const named = new Set(literals);
        for (const [group, members] of Object.entries(groups)) {
          if (named.size !== members.size) continue;
          if ([...named].every((role) => members.has(role))) {
            offenders.push(`${file} re-declares ${group}`);
          }
        }
      }
    }

    expect(offenders, "import the list from @/lib/roles instead of re-declaring it").toEqual([]);
  });
});
