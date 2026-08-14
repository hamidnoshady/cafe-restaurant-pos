import { describe, expect, it } from "vitest";
import { parseDate } from "./reservation-service";

describe("parseDate", () => {
  it("returns null for null, undefined, or empty string", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("returns null for invalid date strings", () => {
    expect(parseDate("invalid-date")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });

  it("returns a Date object for valid date strings", () => {
    const validDateString = "2023-10-27T10:00:00.000Z";
    const parsed = parseDate(validDateString);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.toISOString()).toBe(validDateString);
  });

  it("handles just date strings correctly", () => {
    const dateStr = "2023-10-27";
    const parsed = parseDate(dateStr);
    expect(parsed).toBeInstanceOf(Date);
    // When parsing just a date string, JS assumes UTC
    expect(parsed?.toISOString().startsWith("2023-10-27")).toBe(true);
  });
});
