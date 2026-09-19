import { describe, expect, it } from "vitest";
import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("renders a Jalali date and never a raw ISO string", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("2026-09-18T10:24:00Z")).toMatch(/^[۰-۹0-9]{4}\/[۰-۹0-9]{1,2}\/[۰-۹0-9]{1,2}/);
    expect(formatDateTime("2026-09-18T10:24:00Z")).not.toContain("2026");
  });
});
