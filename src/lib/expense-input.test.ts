import { describe, expect, it } from "vitest";
import {
  EXPENSE_LIST_DEFAULT_LIMIT,
  EXPENSE_LIST_MAX_LIMIT,
  isValidIsoDate,
  parseExpenseListQuery,
} from "./expense-input";

describe("isValidIsoDate", () => {
  it("accepts a real ISO calendar date", () => {
    expect(isValidIsoDate("2025-04-15")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
  });

  it("rejects a well-formed but impossible date", () => {
    // This is the case that used to reach Postgres as raw text and surface as
    // an unhandled 500 instead of a named validation error.
    expect(isValidIsoDate("2025-02-31")).toBe(false);
    expect(isValidIsoDate("2025-13-01")).toBe(false);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
  });

  it("rejects anything that isn't YYYY-MM-DD", () => {
    expect(isValidIsoDate("")).toBe(false);
    expect(isValidIsoDate("1404-01-01T00:00:00Z")).toBe(false);
    expect(isValidIsoDate("15/04/2025")).toBe(false);
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate(20250415)).toBe(false);
  });
});

function q(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe("parseExpenseListQuery", () => {
  it("defaults to no filters and the default window", () => {
    expect(parseExpenseListQuery(q(""))).toEqual({
      dateFrom: null,
      dateTo: null,
      accountId: null,
      paymentAccountId: null,
      q: null,
      limit: EXPENSE_LIST_DEFAULT_LIMIT,
    });
  });

  it("keeps valid dates and drops malformed ones rather than erroring", () => {
    const parsed = parseExpenseListQuery(q("dateFrom=2025-01-01&dateTo=not-a-date"));
    expect(parsed.dateFrom).toBe("2025-01-01");
    expect(parsed.dateTo).toBeNull();
  });

  it("swaps a reversed range — «از» after «تا» is a mis-click, not an empty list", () => {
    const parsed = parseExpenseListQuery(q("dateFrom=2025-06-01&dateTo=2025-01-01"));
    expect(parsed).toMatchObject({ dateFrom: "2025-01-01", dateTo: "2025-06-01" });
  });

  it("accepts account filters only when they look like ids", () => {
    const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    expect(parseExpenseListQuery(q(`accountId=${id}`)).accountId).toBe(id);
    expect(parseExpenseListQuery(q("accountId=5300")).accountId).toBeNull();
    expect(parseExpenseListQuery(q("paymentAccountId=' OR 1=1--")).paymentAccountId).toBeNull();
  });

  it("trims the search term and treats a blank one as absent", () => {
    expect(parseExpenseListQuery(q("q=%20%20")).q).toBeNull();
    expect(parseExpenseListQuery(q("q=%20rent%20")).q).toBe("rent");
  });

  it("clamps the limit and ignores nonsense", () => {
    expect(parseExpenseListQuery(q("limit=25")).limit).toBe(25);
    expect(parseExpenseListQuery(q("limit=100000")).limit).toBe(EXPENSE_LIST_MAX_LIMIT);
    expect(parseExpenseListQuery(q("limit=0")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
    expect(parseExpenseListQuery(q("limit=-5")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
    expect(parseExpenseListQuery(q("limit=abc")).limit).toBe(EXPENSE_LIST_DEFAULT_LIMIT);
  });
});
