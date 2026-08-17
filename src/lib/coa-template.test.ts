import { describe, expect, it } from "vitest";
import {
  ACCESSORIES_COA_TEMPLATE,
  ACCOUNT_LEVELS,
  coaTemplateForIndustry,
  COSMETICS_COA_TEMPLATE,
  COST_OF_SALES_CODES,
  FNB_COA_TEMPLATE,
  JEWELRY_COA_TEMPLATE,
  nextAccountLevel,
  WATCH_COA_TEMPLATE,
  normalBalanceForType,
  validateAccounts,
  WELL_KNOWN_CODES,
  type AccountType,
} from "./coa-template";

// Phase 21 Wave 3: WELL_KNOWN_CODES now spans more than one industry's
// template (jewelry's gold-specific accounts alongside F&B's), so "every
// well-known code" is no longer one flat list every template must contain —
// each template only needs the subset its own industry's posting paths use.
// Waves 5/6 add watch's and accessories' own codes on the same footing.
const OTHER_INDUSTRY_KEYS = new Set([
  "goldInventory",
  "goldSalesRevenue",
  "makingChargeRevenue",
  "goldCogs",
  "consignmentPayable",
  "consignmentCommissionRevenue",
  "watchInventory",
  "watchSalesRevenue",
  "watchCogs",
  "repairServiceRevenue",
  "repairPartsExpense",
  "accessoryInventory",
  "accessorySalesRevenue",
  "accessoryCogs",
  "cosmeticInventory",
  "cosmeticSalesRevenue",
  "cosmeticCogs",
  "cosmeticExpiredAndTester",
  "retailInventoryInTransit",
  "layawayDeposit",
  "goldCustomerAccount",
]);

describe("FNB_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(FNB_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts other steps rely on", () => {
    const codes = new Set(FNB_COA_TEMPLATE.map((a) => a.code));
    for (const [key, code] of Object.entries(WELL_KNOWN_CODES)) {
      if (OTHER_INDUSTRY_KEYS.has(key)) continue;
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
      WELL_KNOWN_CODES.consignmentPayable,
      WELL_KNOWN_CODES.consignmentCommissionRevenue,
    ]) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("WATCH_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(WATCH_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts watch sale and repair posting rely on", () => {
    const codes = new Set(WATCH_COA_TEMPLATE.map((a) => a.code));
    for (const code of [
      WELL_KNOWN_CODES.cash,
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.accountsReceivable,
      WELL_KNOWN_CODES.vatPayable,
      WELL_KNOWN_CODES.watchInventory,
      WELL_KNOWN_CODES.watchSalesRevenue,
      WELL_KNOWN_CODES.watchCogs,
      WELL_KNOWN_CODES.repairServiceRevenue,
      WELL_KNOWN_CODES.repairPartsExpense,
    ]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("carries none of F&B's menu/recipe-shaped accounts", () => {
    const codes = new Set(WATCH_COA_TEMPLATE.map((a) => a.code));
    expect(codes.has(WELL_KNOWN_CODES.inventory)).toBe(false);
    expect(codes.has(WELL_KNOWN_CODES.cogs)).toBe(false);
  });
});

describe("ACCESSORIES_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(ACCESSORIES_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts accessory sale posting relies on", () => {
    const codes = new Set(ACCESSORIES_COA_TEMPLATE.map((a) => a.code));
    for (const code of [
      WELL_KNOWN_CODES.cash,
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.accountsReceivable,
      WELL_KNOWN_CODES.vatPayable,
      WELL_KNOWN_CODES.accessoryInventory,
      WELL_KNOWN_CODES.accessorySalesRevenue,
      WELL_KNOWN_CODES.accessoryCogs,
    ]) {
      expect(codes.has(code)).toBe(true);
    }
  });
});

describe("COSMETICS_COA_TEMPLATE", () => {
  it("is itself valid", () => {
    expect(validateAccounts(COSMETICS_COA_TEMPLATE)).toEqual([]);
  });

  it("contains the well-known accounts cosmetic sale posting relies on", () => {
    const codes = new Set(COSMETICS_COA_TEMPLATE.map((a) => a.code));
    for (const code of [
      WELL_KNOWN_CODES.cash,
      WELL_KNOWN_CODES.bankClearing,
      WELL_KNOWN_CODES.accountsReceivable,
      WELL_KNOWN_CODES.vatPayable,
      WELL_KNOWN_CODES.cosmeticInventory,
      WELL_KNOWN_CODES.cosmeticSalesRevenue,
      WELL_KNOWN_CODES.cosmeticCogs,
      WELL_KNOWN_CODES.cosmeticExpiredAndTester,
    ]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  it("carries none of F&B's menu/recipe-shaped accounts", () => {
    const codes = new Set(COSMETICS_COA_TEMPLATE.map((a) => a.code));
    expect(codes.has(WELL_KNOWN_CODES.inventory)).toBe(false);
    expect(codes.has(WELL_KNOWN_CODES.cogs)).toBe(false);
  });
});

describe("coaTemplateForIndustry", () => {
  it("gives each industry its own template", () => {
    expect(coaTemplateForIndustry("food_service")).toBe(FNB_COA_TEMPLATE);
    expect(coaTemplateForIndustry("jewelry")).toBe(JEWELRY_COA_TEMPLATE);
    expect(coaTemplateForIndustry("watch")).toBe(WATCH_COA_TEMPLATE);
    expect(coaTemplateForIndustry("accessories")).toBe(ACCESSORIES_COA_TEMPLATE);
    expect(coaTemplateForIndustry("cosmetics")).toBe(COSMETICS_COA_TEMPLATE);
  });
});

describe("nextAccountLevel", () => {
  it("is group for no parent", () => {
    expect(nextAccountLevel(null)).toBe("group");
  });

  it("walks group -> kol -> moein -> tafsili", () => {
    expect(nextAccountLevel("group")).toBe("kol");
    expect(nextAccountLevel("kol")).toBe("moein");
    expect(nextAccountLevel("moein")).toBe("tafsili");
  });

  it("returns null past the deepest tier — تفصیلی can't have children", () => {
    expect(nextAccountLevel("tafsili")).toBeNull();
  });

  it("covers every declared level exactly once", () => {
    expect(ACCOUNT_LEVELS).toEqual(["group", "kol", "moein", "tafsili"]);
  });
});

describe("normalBalanceForType", () => {
  it("asset and expense are debit-normal", () => {
    expect(normalBalanceForType("asset")).toBe("debit");
    expect(normalBalanceForType("expense")).toBe("debit");
  });

  it("liability, equity, and revenue are credit-normal", () => {
    expect(normalBalanceForType("liability")).toBe("credit");
    expect(normalBalanceForType("equity")).toBe("credit");
    expect(normalBalanceForType("revenue")).toBe("credit");
  });

  it("every account type maps to exactly one normal balance", () => {
    const types: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];
    for (const t of types) {
      expect(["debit", "credit"]).toContain(normalBalanceForType(t));
    }
  });
});

describe("contra accounts in the F&B template", () => {
  it("marks sales returns, the NRV allowance, accumulated depreciation and applied conversion cost as contra, and nothing else", () => {
    const contraCodes = FNB_COA_TEMPLATE.filter((a) => a.isContra).map((a) => a.code);
    expect(contraCodes.sort()).toEqual(["1390", "1510", "4400", "5180"]);
  });

  it("keeps applied conversion cost out of cost of sales", () => {
    // 5180 offsets the wages/utilities a production run capitalised, both of
    // which sit outside gross profit. Counting it as cost of sales would
    // overstate margin in the period a batch was made and understate it in the
    // period it sold — the exact distortion capitalising the cost avoids.
    expect(COST_OF_SALES_CODES).not.toContain(WELL_KNOWN_CODES.appliedConversionCost);
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
