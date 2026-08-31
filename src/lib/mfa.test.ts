import { describe, it, expect } from "vitest";
import { enrolmentRequirement, graceDaysRemaining, mfaAppliesToRole } from "./mfa";

describe("mfa enrolmentRequirement", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("returns not_required if already enrolled", () => {
    expect(
      enrolmentRequirement({ hasPrimary: true, graceUntil: null, hasGraceRecord: false, role: "owner" }, now)
    ).toBe("not_required");
  });

  it("returns grace if grace period is active", () => {
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: new Date("2024-01-15T12:00:00Z"), hasGraceRecord: true, role: "owner" },
        now
      )
    ).toBe("grace");
  });

  it("returns required if grace period has expired", () => {
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: new Date("2024-01-05T12:00:00Z"), hasGraceRecord: true, role: "owner" },
        now
      )
    ).toBe("required");
  });

  it("returns grace if no record exists yet", () => {
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: null, hasGraceRecord: false, role: "owner" },
        now
      )
    ).toBe("grace");
  });
});

describe("graceDaysRemaining", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("is null when there is no window to count", () => {
    expect(graceDaysRemaining(null, now)).toBeNull();
  });

  it("rounds up — a window closing in eleven hours must not read as zero days", () => {
    expect(graceDaysRemaining(new Date("2024-01-10T23:00:00Z"), now)).toBe(1);
  });

  it("counts whole days", () => {
    expect(graceDaysRemaining(new Date("2024-01-13T12:00:00Z"), now)).toBe(3);
  });

  it("floors at zero rather than going negative once expired", () => {
    expect(graceDaysRemaining(new Date("2024-01-01T12:00:00Z"), now)).toBe(0);
  });
});

describe("mfaAppliesToRole", () => {
  it("always applies to the owner — the full permission set is the point of the wave", () => {
    expect(mfaAppliesToRole("owner")).toBe(true);
    expect(mfaAppliesToRole("owner", false)).toBe(true);
  });

  it("applies to a manager only where the business opted in; off by default", () => {
    expect(mfaAppliesToRole("manager")).toBe(false);
    expect(mfaAppliesToRole("manager", true)).toBe(true);
  });

  it("never applies to the PIN roles — a till cannot receive an SMS mid-service", () => {
    for (const role of ["cashier", "waiter", "kitchen"]) {
      expect(mfaAppliesToRole(role, true)).toBe(false);
    }
  });
});
