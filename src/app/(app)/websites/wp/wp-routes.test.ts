/**
 * The WP Manager's section gate.
 *
 * Was `["owner", "manager"].includes(role)` for every section alike, while the
 * routes behind those sections enforced `website.*` capability keys. The gate
 * asks the routes' question now, and these tests pin two things: that each
 * built-in preset reaches exactly what it reached before, and that the one
 * section which *acts* on the live shop is separated from the ones that only
 * read it.
 */
import { describe, expect, it } from "vitest";
import { WP_SECTION_KEYS, canViewWpSection, type WpSectionKey } from "./wp-routes";
import { roleBasePermissions } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

function of(role: Role | "none"): ReadonlySet<string> {
  return new Set<string>(role === "none" ? [] : roleBasePermissions(role));
}

const READ_ONLY_SECTIONS: readonly WpSectionKey[] = WP_SECTION_KEYS.filter((k) => k !== "queue");

describe("canViewWpSection", () => {
  it("gives owner and manager the whole manager, as before", () => {
    for (const role of ["owner", "admin", "manager"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(true);
      }
    }
  });

  it("still refuses the floor and the books entirely", () => {
    // The manager writes to a live shopfront and reads every customer record;
    // nothing in the till or ledger presets should reach it.
    for (const role of ["cashier", "waiter", "kitchen", "accountant", "none"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(false);
      }
    }
  });

  it("lets a read-only viewer look without handing them the sync queue", () => {
    // The split this migration introduced. Being refused the whole manager
    // because one of its eight sections is a control panel is the kind of
    // all-or-nothing gate the permission model exists to replace.
    for (const key of READ_ONLY_SECTIONS) {
      expect(canViewWpSection(of("viewer"), key), key).toBe(true);
    }
    expect(canViewWpSection(of("viewer"), "queue")).toBe(false);
  });

  it("follows an override rather than the preset it came from", () => {
    const cashierPlusRead = new Set([...of("cashier"), "website.view"]);
    expect(canViewWpSection(cashierPlusRead, "products")).toBe(true);
    expect(canViewWpSection(cashierPlusRead, "queue")).toBe(false);

    const managerMinusManage = new Set(
      [...of("manager")].filter((p) => p !== "website.manage"),
    );
    expect(canViewWpSection(managerMinusManage, "queue")).toBe(false);
    expect(canViewWpSection(managerMinusManage, "overview")).toBe(true);
  });

  it("has a decision for every section, so a new one cannot default to open", () => {
    // A section added to WP_SECTION_KEYS without an entry in the permission map
    // would look up `undefined` and — if the map were a plain lookup with a
    // fallback — be reachable by anyone. It must be reachable by no one.
    for (const key of WP_SECTION_KEYS) {
      expect(canViewWpSection(new Set(), key), key).toBe(false);
    }
  });
});
