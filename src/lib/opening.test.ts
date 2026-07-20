import { describe, expect, it } from "vitest";
import { checkBalance, validateOpeningLines, withAutoOffset } from "./opening";

const line = (accountId: string, debit = 0, credit = 0) => ({ accountId, debit, credit });

describe("checkBalance", () => {
  it("detects a balanced entry", () => {
    const r = checkBalance([line("a", 5_000_000), line("b", 0, 5_000_000)]);
    expect(r.balanced).toBe(true);
    expect(r.totalDebit).toBe(5_000_000);
    expect(r.totalCredit).toBe(5_000_000);
  });

  it("reports the difference when unbalanced", () => {
    const r = checkBalance([line("a", 3_000), line("b", 0, 1_000)]);
    expect(r.balanced).toBe(false);
    expect(r.difference).toBe(2_000);
  });
});

describe("validateOpeningLines", () => {
  it("rejects empty entries", () => {
    expect(validateOpeningLines([])).toHaveLength(1);
    expect(validateOpeningLines([line("a")])).toHaveLength(1);
  });

  it("rejects a line that is both debit and credit", () => {
    expect(validateOpeningLines([line("a", 100, 100)])).toHaveLength(1);
  });

  it("rejects duplicate accounts and negative amounts", () => {
    expect(validateOpeningLines([line("a", 100), line("a", 200)])).toHaveLength(1);
    expect(validateOpeningLines([line("a", -5)])).toHaveLength(1);
  });

  it("accepts a proper entry", () => {
    expect(validateOpeningLines([line("a", 100), line("b", 0, 100)])).toEqual([]);
  });
});

describe("withAutoOffset", () => {
  it("returns lines unchanged when balanced", () => {
    const lines = [line("a", 100), line("b", 0, 100)];
    expect(withAutoOffset(lines, "eq")).toEqual(lines);
  });

  it("credits the offset account when debits exceed credits", () => {
    const result = withAutoOffset([line("cash", 7_000_000)], "eq");
    expect(checkBalance(result).balanced).toBe(true);
    expect(result).toContainEqual(line("eq", 0, 7_000_000));
  });

  it("debits the offset account when credits exceed debits", () => {
    const result = withAutoOffset([line("loan", 0, 2_000_000)], "eq");
    expect(checkBalance(result).balanced).toBe(true);
    expect(result).toContainEqual(line("eq", 2_000_000, 0));
  });

  it("merges with an existing offset-account line", () => {
    const result = withAutoOffset([line("cash", 5_000), line("eq", 0, 2_000)], "eq");
    expect(checkBalance(result).balanced).toBe(true);
    expect(result.filter((l) => l.accountId === "eq")).toEqual([line("eq", 0, 5_000)]);
  });

  it("drops zero-value lines", () => {
    const result = withAutoOffset([line("cash", 100), line("x", 0, 0)], "eq");
    expect(result.find((l) => l.accountId === "x")).toBeUndefined();
  });
});
