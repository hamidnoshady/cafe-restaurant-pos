import { describe, it, expect } from "vitest";
import { enrolmentRequirement } from "./mfa";

describe("mfa enrolmentRequirement", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("returns not_required if already enrolled", () => {
    expect(
      enrolmentRequirement({ hasPrimary: true, graceUntil: null, role: "owner" }, now)
    ).toBe("not_required");
  });

  it("returns grace if grace period is active", () => {
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: new Date("2024-01-15T12:00:00Z"), role: "owner" },
        now
      )
    ).toBe("grace");
  });

  it("returns required if grace period has expired", () => {
    expect(
      enrolmentRequirement(
        { hasPrimary: false, graceUntil: new Date("2024-01-05T12:00:00Z"), role: "owner" },
        now
      )
    ).toBe("required");
  });
});
