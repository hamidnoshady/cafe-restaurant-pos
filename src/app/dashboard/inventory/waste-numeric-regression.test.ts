import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatPersianNumericText, normalizeNumericText } from "@/lib/digits";
import { validateQuantityText } from "@/lib/numeric-validation";

describe("waste numeric input regression", () => {
  it("keeps a localized display and canonical exact API quantity", () => {
    const canonical = normalizeNumericText("۲۰۳۰", { allowDecimal: true, allowNegative: false });
    expect(canonical).toBe("2030");
    expect(formatPersianNumericText(canonical, { allowDecimal: true, allowNegative: false })).toBe("۲٬۰۳۰");
    expect(validateQuantityText(canonical).valid).toBe(true);
    expect(JSON.parse(JSON.stringify({ quantity: canonical }))).toEqual({ quantity: "2030" });
  });

  it("has no native pattern conflict and sends the canonical state value", () => {
    const source = readFileSync(new URL("./waste-section.tsx", import.meta.url), "utf8");
    const input = source.match(/<PersianNumberInput\b[\s\S]*?\/>/)?.[0] ?? "";
    expect(input).not.toContain("pattern=");
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain("allowNegative={false}");
    expect(source).toContain("buildWasteRequestBody(inventoryItemId, qty, reason, note)");
    expect(source).toContain("validateQuantityText(qty)");
  });
});
