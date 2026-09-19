import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./product-add-section.tsx", import.meta.url), "utf8");

describe("add-product interaction regressions", () => {
  it("preserves the barcode when the final variant is removed", () => {
    expect(source).toContain("function removeVariantRow(variantId: DraftId)");
    expect(source).toContain("barcode: finalVariant?.barcode || current.barcode");
    expect(source).toContain("onClick={() => removeVariantRow(variant.id)}");
  });

  it("does not submit hidden attributes left in an older local draft", () => {
    expect(source).toContain("const activeAttributeNames = new Set");
    expect(source).toContain("activeAttributeNames.has(name) && value.trim()");
  });

  it("prevents the UI from exceeding the server's variant limit", () => {
    expect(source).toContain("disabled={form.variants.length >= 100}");
    expect(source).toContain("حداکثر ۱۰۰ تنوع ثبت شده است");
  });
});
