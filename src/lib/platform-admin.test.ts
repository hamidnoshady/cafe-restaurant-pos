/**
 * Phase 15 — the pure decisions behind the super-admin console.
 *
 * These are the parts a reviewer most wants pinned: which role may do what,
 * how long an impersonation window may last, and when an archived business
 * becomes eligible for hard-delete. Everything DB-touching leans on these and
 * is left to the integration test.
 */
import { describe, expect, it } from "vitest";
import {
  platformCan,
  CAPABILITIES_FOR,
  clampImpersonationMinutes,
  isDeleteEligible,
  MAX_IMPERSONATION_MINUTES,
  DEFAULT_IMPERSONATION_MINUTES,
  PLATFORM_ADMIN_ROLES,
} from "./platform-admin";

describe("platformCan — role → capability presets", () => {
  it("support reads everything and may only impersonate read-only", () => {
    expect(platformCan("support", "businesses.read")).toBe(true);
    expect(platformCan("support", "audit.read")).toBe(true);
    expect(platformCan("support", "system.read")).toBe(true);
    expect(platformCan("support", "usage.read")).toBe(true);
    expect(platformCan("support", "impersonate.readOnly")).toBe(true);
    // …but changes nothing.
    expect(platformCan("support", "features.write")).toBe(false);
    expect(platformCan("support", "business.suspend")).toBe(false);
    expect(platformCan("support", "impersonate.full")).toBe(false);
    expect(platformCan("support", "business.provision")).toBe(false);
    expect(platformCan("support", "business.delete")).toBe(false);
    expect(platformCan("support", "admins.manage")).toBe(false);
  });

  it("engineer adds operational writes but not the owner-only powers", () => {
    expect(platformCan("engineer", "features.write")).toBe(true);
    expect(platformCan("engineer", "business.suspend")).toBe(true);
    expect(platformCan("engineer", "impersonate.revoke")).toBe(true);
    // Still not full-access impersonation, provisioning, archive/delete, or admin mgmt.
    expect(platformCan("engineer", "impersonate.full")).toBe(false);
    expect(platformCan("engineer", "business.provision")).toBe(false);
    expect(platformCan("engineer", "business.archive")).toBe(false);
    expect(platformCan("engineer", "business.delete")).toBe(false);
    expect(platformCan("engineer", "admins.manage")).toBe(false);
  });

  it("owner holds every capability", () => {
    for (const cap of CAPABILITIES_FOR("owner")) {
      expect(platformCan("owner", cap)).toBe(true);
    }
    expect(platformCan("owner", "business.provision")).toBe(true);
    expect(platformCan("owner", "business.delete")).toBe(true);
    expect(platformCan("owner", "impersonate.full")).toBe(true);
    expect(platformCan("owner", "admins.manage")).toBe(true);
  });

  it("higher roles are supersets of lower ones", () => {
    for (const cap of CAPABILITIES_FOR("support")) {
      expect(platformCan("engineer", cap), cap).toBe(true);
      expect(platformCan("owner", cap), cap).toBe(true);
    }
    for (const cap of CAPABILITIES_FOR("engineer")) {
      expect(platformCan("owner", cap), cap).toBe(true);
    }
  });

  it("exposes exactly three roles", () => {
    expect(PLATFORM_ADMIN_ROLES).toEqual(["support", "engineer", "owner"]);
  });
});

describe("clampImpersonationMinutes — short, bounded windows", () => {
  it("defaults when unset, zero, negative, or non-finite", () => {
    expect(clampImpersonationMinutes(undefined)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(0)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(-5)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(Number.NaN)).toBe(DEFAULT_IMPERSONATION_MINUTES);
  });

  it("passes a sane request through, flooring fractions", () => {
    expect(clampImpersonationMinutes(15)).toBe(15);
    expect(clampImpersonationMinutes(20.9)).toBe(20);
  });

  it("caps at the maximum", () => {
    expect(clampImpersonationMinutes(1000)).toBe(MAX_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(MAX_IMPERSONATION_MINUTES + 1)).toBe(MAX_IMPERSONATION_MINUTES);
  });
});

describe("isDeleteEligible — the hard-delete grace window", () => {
  const grace = 30;
  const now = new Date("2025-02-01T00:00:00Z");

  it("a business that isn't archived is never eligible", () => {
    expect(isDeleteEligible(null, now, grace)).toBe(false);
  });

  it("within the grace window it is not yet eligible", () => {
    const archived = new Date("2025-01-20T00:00:00Z"); // 12 days ago
    expect(isDeleteEligible(archived, now, grace)).toBe(false);
  });

  it("exactly at the boundary it becomes eligible", () => {
    const archived = new Date("2025-01-02T00:00:00Z"); // exactly 30 days ago
    expect(isDeleteEligible(archived, now, grace)).toBe(true);
  });

  it("well past the window it is eligible", () => {
    const archived = new Date("2024-12-01T00:00:00Z");
    expect(isDeleteEligible(archived, now, grace)).toBe(true);
  });

  it("accepts an ISO string and rejects an unparseable one", () => {
    expect(isDeleteEligible("2024-12-01T00:00:00Z", now, grace)).toBe(true);
    expect(isDeleteEligible("not-a-date", now, grace)).toBe(false);
  });
});
