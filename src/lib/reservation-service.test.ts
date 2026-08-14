import { describe, expect, it } from "vitest";
import { parseDate } from "./reservation-service";

describe("parseDate", () => {
  it("returns null for null, undefined, or empty string", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("returns null for an invalid date string", () => {
    expect(parseDate("not-a-date")).toBeNull();
    expect(parseDate("2024-13-45")).toBeNull();
  });

  it("parses a valid ISO date string into a Date object", () => {
    const validDateString = "2024-05-20T14:30:00.000Z";
    const result = parseDate(validDateString);
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe(validDateString);
  });

  it("parses a simple date string as UTC", () => {
    const result = parseDate("2024-05-20");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getUTCFullYear()).toBe(2024);
    expect(result?.getUTCMonth()).toBe(4); // 0-indexed, so 4 is May
    expect(result?.getUTCDate()).toBe(20);
  });
});
