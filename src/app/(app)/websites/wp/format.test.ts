import { describe, expect, it } from "vitest";
import { formatDateTime, formatStoreAmount, parseAmountInput } from "./format";

/**
 * The WP Manager's input/display plumbing. `parseAmountInput` exists because
 * the inline parsing it replaced turned Persian-digit input into a *zero
 * price push* to a live store — the one bug in this panel that destroys data
 * on the other side of the connection.
 */
describe("parseAmountInput", () => {
  it("reads Latin digits with separators", () => {
    expect(parseAmountInput("120000")).toBe(120000);
    expect(parseAmountInput("120,000")).toBe(120000);
    expect(parseAmountInput("120 000")).toBe(120000);
    expect(parseAmountInput("12.5")).toBe(12.5);
    expect(parseAmountInput("1,250,000")).toBe(1250000);
  });

  it("reads Persian and Arabic-Indic digits with their own marks", () => {
    expect(parseAmountInput("۱۲۰۰۰۰")).toBe(120000);
    expect(parseAmountInput("۱۲۰٬۰۰۰")).toBe(120000);
    expect(parseAmountInput("۱۲٫۵")).toBe(12.5);
    expect(parseAmountInput("١٢٣")).toBe(123);
  });

  it("refuses text-bearing input rather than guessing a price", () => {
    expect(parseAmountInput("۱۲۰ هزار تومان")).toBeNull();
    expect(parseAmountInput("about 120")).toBeNull();
  });

  it("can be restricted to whole numbers for stock", () => {
    expect(parseAmountInput("12.5", { allowDecimal: false })).toBe(12);
    expect(parseAmountInput("۱۲٬۵۰۰", { allowDecimal: false })).toBe(12500);
  });

  it("returns null for input that carries no number, never 0", () => {
    // The old parser stripped Persian digits and Number("") === 0 — the
    // exact path that pushed a zero price to the store.
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("   ")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
    expect(parseAmountInput("--")).toBeNull();
  });
});

describe("formatStoreAmount", () => {
  it("groups digits in Persian and appends the store currency when present", () => {
    expect(formatStoreAmount("185000.00")).toBe("۱۸۵٬۰۰۰");
    expect(formatStoreAmount("185000.00", "IRT")).toBe("۱۸۵٬۰۰۰ IRT");
    expect(formatStoreAmount("92000", "IRI")).toBe("۹۲٬۰۰۰ IRI");
  });

  it("passes through what it cannot parse rather than inventing a number", () => {
    expect(formatStoreAmount(null)).toBe("—");
    expect(formatStoreAmount("")).toBe("—");
    expect(formatStoreAmount("n/a")).toBe("n/a");
  });
});

describe("formatDateTime", () => {
  it("renders a Jalali date and never a raw ISO string", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("2026-09-18T10:24:00Z")).toMatch(/^[۰-۹0-9]{4}\/[۰-۹0-9]{1,2}\/[۰-۹0-9]{1,2}/);
    expect(formatDateTime("2026-09-18T10:24:00Z")).not.toContain("2026");
  });
});
