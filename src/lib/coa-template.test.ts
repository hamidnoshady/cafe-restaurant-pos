import { describe, expect, it } from "vitest";
import { FNB_COA_TEMPLATE, validateAccounts, WELL_KNOWN_CODES } from "./coa-template";

describe("FNB_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(FNB_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts other steps rely on", () => {
    const codes = new Set(FNB_COA_TEMPLATE.map((a) => a.code));
    for (const code of Object.values(WELL_KNOWN_CODES)) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("validateAccounts", () => {
  it("rejects duplicate codes", () => {
    const errors = validateAccounts([
      { code: "1000", name: "الف", type: "asset" },
      { code: "1000", name: "ب", type: "asset" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a missing parent", () => {
    const errors = validateAccounts([{ code: "1100", name: "صندوق", type: "asset", parentCode: "1000" }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty list", () => {
    expect(validateAccounts([]).length).toBeGreaterThan(0);
  });
});
