/**
 * Phase 15 — the pure decisions behind the super-admin console.
 *
 * These are the parts a reviewer most wants pinned: which role may do what,
 * and how long an impersonation window may last. Everything DB-touching leans
 * on these and is left to the integration test.
 */
import { describe, expect, it } from "vitest";
import {
  platformCan,
  CAPABILITIES_FOR,
  clampImpersonationMinutes,
  MAX_IMPERSONATION_MINUTES,
  DEFAULT_IMPERSONATION_MINUTES,
  PLATFORM_ADMIN_ROLES,
} from "./platform-admin";

describe("platformCan — role → capability presets", () => {
  it("support reads everything, runs the support desk, and may only impersonate read-only", () => {
    expect(platformCan("support", "businesses.read")).toBe(true);
    expect(platformCan("support", "audit.read")).toBe(true);
    expect(platformCan("support", "system.read")).toBe(true);
    expect(platformCan("support", "usage.read")).toBe(true);
    expect(platformCan("support", "ai.read")).toBe(true);
    // Migration 0130 — answering support tickets is the support role's job.
    expect(platformCan("support", "support.manage")).toBe(true);
    expect(platformCan("support", "impersonate.readOnly")).toBe(true);
    // …but changes nothing else.
    expect(platformCan("support", "features.write")).toBe(false);
    expect(platformCan("support", "business.suspend")).toBe(false);
    expect(platformCan("support", "ai.credits.manage")).toBe(false);
    expect(platformCan("support", "impersonate.full")).toBe(false);
    expect(platformCan("support", "business.provision")).toBe(false);
    expect(platformCan("support", "business.delete")).toBe(false);
    expect(platformCan("support", "business.edit")).toBe(false);
    expect(platformCan("support", "business.reset")).toBe(false);
    expect(platformCan("support", "admins.manage")).toBe(false);
    expect(platformCan("support", "updates.manage")).toBe(false);
    expect(platformCan("support", "ai.config.manage")).toBe(false);
    expect(platformCan("support", "knowledge.manage")).toBe(false);
  });

  it("engineer adds operational writes but not the owner-only powers", () => {
    expect(platformCan("engineer", "support.manage")).toBe(true);
    expect(platformCan("engineer", "features.write")).toBe(true);
    expect(platformCan("engineer", "business.suspend")).toBe(true);
    expect(platformCan("engineer", "ai.credits.manage")).toBe(true);
    expect(platformCan("engineer", "impersonate.revoke")).toBe(true);
    // Still not full-access impersonation, provisioning, archive/delete, or admin mgmt.
    expect(platformCan("engineer", "impersonate.full")).toBe(false);
    expect(platformCan("engineer", "business.provision")).toBe(false);
    expect(platformCan("engineer", "business.archive")).toBe(false);
    expect(platformCan("engineer", "business.delete")).toBe(false);
    expect(platformCan("engineer", "business.edit")).toBe(false);
    expect(platformCan("engineer", "business.reset")).toBe(false);
    expect(platformCan("engineer", "admins.manage")).toBe(false);
    expect(platformCan("engineer", "updates.manage")).toBe(false);
    expect(platformCan("engineer", "ai.config.manage")).toBe(false);
  });

  it("owner holds every capability", () => {
    for (const cap of CAPABILITIES_FOR("owner")) {
      expect(platformCan("owner", cap)).toBe(true);
    }
    expect(platformCan("owner", "business.provision")).toBe(true);
    expect(platformCan("owner", "business.delete")).toBe(true);
    expect(platformCan("owner", "business.edit")).toBe(true);
    expect(platformCan("owner", "business.reset")).toBe(true);
    expect(platformCan("owner", "impersonate.full")).toBe(true);
    expect(platformCan("owner", "admins.manage")).toBe(true);
    expect(platformCan("owner", "updates.manage")).toBe(true);
    expect(platformCan("owner", "ai.config.manage")).toBe(true);
  });

  it("backup is split so that overwriting the deployment stays owner-only", () => {
    // Migration 0132's two capabilities, and the line between them. Running the
    // schedule, reading history and issuing a peer token is operational work an
    // engineer does every day; pointing a production install at another server's
    // file and replacing every business in it destroys more data than deleting
    // every business one at a time, so it stops at the owner.
    for (const role of ["engineer", "owner"] as const) {
      expect(platformCan(role, "backup.manage"), role).toBe(true);
    }
    for (const role of ["support", "engineer"] as const) {
      expect(platformCan(role, "backup.restore"), role).toBe(false);
    }
    expect(platformCan("support", "backup.manage")).toBe(false);
    expect(platformCan("owner", "backup.restore")).toBe(true);

    // The console's read-only views (health, run history, artifact list) are not
    // a capability of their own: they sit behind `system.read`, which every role
    // holds — an engineer answering «کپی دیشب گرفته شد؟» must be able to look.
    for (const role of PLATFORM_ADMIN_ROLES) {
      expect(platformCan(role, "system.read"), role).toBe(true);
    }
    // …and `backup.restore` is never granted without `backup.manage`, or the
    // restore button would appear for someone who cannot see a backup to pick.
    for (const role of PLATFORM_ADMIN_ROLES) {
      if (platformCan(role, "backup.restore")) expect(platformCan(role, "backup.manage"), role).toBe(true);
    }
  });

  it("administering the website platform is operations, reading it is not gated at all", () => {
    // Migration 0139. An engineer keeps the fleet's websites serving — suspending a
    // site, re-issuing a key, pushing content back after a bad edit — for the same
    // reason they run backups: the alternative is opening the CMS's own admin on
    // another host, where none of it is audited here.
    for (const role of ["engineer", "owner"] as const) {
      expect(platformCan(role, "cms.manage"), role).toBe(true);
    }
    expect(platformCan("support", "cms.manage")).toBe(false);
    // The CMS report itself rides `system.read`, which every role holds: a support
    // operator answering «سایت مشتری بالا هست؟» must be able to look without being
    // able to change anything.
    for (const role of PLATFORM_ADMIN_ROLES) {
      expect(platformCan(role, "system.read"), role).toBe(true);
    }
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
    expect(clampImpersonationMinutes(undefined)).toBe(
      DEFAULT_IMPERSONATION_MINUTES,
    );
    expect(clampImpersonationMinutes(0)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(-5)).toBe(DEFAULT_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(Number.NaN)).toBe(
      DEFAULT_IMPERSONATION_MINUTES,
    );
  });

  it("passes a sane request through, flooring fractions", () => {
    expect(clampImpersonationMinutes(15)).toBe(15);
    expect(clampImpersonationMinutes(20.9)).toBe(20);
  });

  it("caps at the maximum", () => {
    expect(clampImpersonationMinutes(1000)).toBe(MAX_IMPERSONATION_MINUTES);
    expect(clampImpersonationMinutes(MAX_IMPERSONATION_MINUTES + 1)).toBe(
      MAX_IMPERSONATION_MINUTES,
    );
  });

  it("handles exact boundary values correctly", () => {
    expect(clampImpersonationMinutes(1)).toBe(1);
    expect(clampImpersonationMinutes(MAX_IMPERSONATION_MINUTES)).toBe(
      MAX_IMPERSONATION_MINUTES,
    );
  });
});
