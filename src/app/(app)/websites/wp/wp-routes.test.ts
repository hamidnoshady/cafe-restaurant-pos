/**
 * The WP Manager's section gate asks for woocommerce.view, the same capability
 * the manager's read routes enforce.
 */
import { describe, expect, it } from "vitest";
import { WP_SECTION_KEYS, canViewWpSection } from "./wp-routes";
import { roleBasePermissions, type Permission } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

function of(role: Role | "none"): ReadonlySet<Permission> {
  return new Set<Permission>(role === "none" ? [] : roleBasePermissions(role));
}

describe("canViewWpSection", () => {
  it("gives owner, admin and manager the whole manager", () => {
    for (const role of ["owner", "admin", "manager"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(true);
      }
    }
  });

  it("refuses roles that do not hold woocommerce.view", () => {
    for (const role of ["cashier", "waiter", "kitchen", "accountant", "none"] as const) {
      for (const key of WP_SECTION_KEYS) {
        expect(canViewWpSection(of(role), key), `${role}/${key}`).toBe(false);
      }
    }
  });

  it("follows a woocommerce.view grant rather than the preset it came from", () => {
    const cashierPlusRead = new Set<Permission>([...of("cashier"), "woocommerce.view"]);
    expect(canViewWpSection(cashierPlusRead, "products")).toBe(true);
    expect(canViewWpSection(cashierPlusRead, "queue")).toBe(true);

    const managerMinusView = new Set<Permission>(
      [...of("manager")].filter((p) => p !== "woocommerce.view" && p !== "woocommerce.manage"),
    );
    // manage implies view, so stripping both is what closes the door.
    expect(canViewWpSection(managerMinusView, "overview")).toBe(false);
  });

  it("stays closed with an empty permission set", () => {
    for (const key of WP_SECTION_KEYS) {
      expect(canViewWpSection(new Set(), key), key).toBe(false);
    }
  });
});
