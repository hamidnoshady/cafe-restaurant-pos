import { describe, expect, it } from "vitest";
import { FNB_COA_TEMPLATE, JEWELRY_COA_TEMPLATE, validateAccounts, WELL_KNOWN_CODES } from "./coa-template";

// Phase 21 Wave 3: WELL_KNOWN_CODES now spans more than one industry's
// template (jewelry's gold-specific accounts alongside F&B's), so "every
// well-known code" is no longer one flat list every template must contain —
// each template only needs the subset its own industry's posting paths use.
const JEWELRY_ONLY_KEYS = new Set(["goldInventory", "goldSalesRevenue", "makingChargeRevenue", "goldCogs"]);

describe("FNB_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(FNB_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts other steps rely on", () => {
    const codes = new Set(FNB_COA_TEMPLATE.map((a) => a.code));
    for (const [key, code] of Object.entries(WELL_KNOWN_CODES)) {
      if (JEWELRY_ONLY_KEYS.has(key)) continue;
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("JEWELRY_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(JEWELRY_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts gold-sale posting relies on", () => {
    const codes = new Set(JEWELRY_COA_TEMPLATE.map((a) => a.code));
    for (const code of [
      WELL_KNOWN_CODES.cash,
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.accountsReceivable,
      WELL_KNOWN_CODES.vatReceivable,
      WELL_KNOWN_CODES.accountsPayable,
      WELL_KNOWN_CODES.vatPayable,
      WELL_KNOWN_CODES.goldInventory,
      WELL_KNOWN_CODES.goldSalesRevenue,
      WELL_KNOWN_CODES.makingChargeRevenue,
      WELL_KNOWN_CODES.goldCogs,
    ]) {
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
