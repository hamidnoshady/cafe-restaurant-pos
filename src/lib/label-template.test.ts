import { describe, expect, it } from "vitest";
import { labelFieldsForTrade, renderLabelHtml, type LabelItem, type LabelTrade } from "./label-template";

const baseItem: LabelItem = { name: "کالای نمونه", price: 1_250_000 };

describe("labelFieldsForTrade", () => {
  it("cosmetics prints price, shade and expiry", () => {
    const fields = labelFieldsForTrade("cosmetics", {
      ...baseItem,
      shade: "قرمز آتشین",
      expiryDate: "2027-03-01",
    });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "رنگ", "انقضا"]);
    expect(fields[0].value).toBe("۱۲۵٬۰۰۰");
  });

  it("jewelry prints price, عیار and وزن", () => {
    const fields = labelFieldsForTrade("jewelry", { ...baseItem, purity: "۱۸", weight: "۱٫۲۳ گرم" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "عیار", "وزن"]);
    expect(fields[2].value).toBe("۱٫۲۳ گرم");
  });

  it("watch prints price, model and serial", () => {
    const fields = labelFieldsForTrade("watch", { ...baseItem, model: "Seiko 5", serial: "S-1001" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "مدل", "سریال"]);
  });

  it("accessories prints price and size", () => {
    const fields = labelFieldsForTrade("accessories", { ...baseItem, size: "سایز ۵۵" });
    expect(fields.map((f) => f.label)).toEqual(["قیمت", "سایز"]);
  });

  it("omits absent fields instead of printing empty rows", () => {
    const fields = labelFieldsForTrade("cosmetics", { name: "بدون ویژگی" });
    expect(fields).toEqual([]);
  });
});

describe("renderLabelHtml", () => {
  const trades: LabelTrade[] = ["jewelry", "watch", "accessories", "cosmetics"];

  it.each(trades)("renders a %s label with its trade fields", (trade) => {
    const item: LabelItem =
      trade === "cosmetics"
        ? { name: "رژ لب", price: 800_000, shade: "قرمز", expiryDate: "2027-01-01" }
        : trade === "jewelry"
          ? { name: "انگشتر", price: 50_000_000, purity: "۱۸", weight: "۲٫۵ گرم" }
          : trade === "watch"
            ? { name: "ساعت مچی", price: 30_000_000, model: "S5", serial: "1001" }
            : { name: "دستبند", price: 400_000, size: "سایز ۵۵" };

    const html = renderLabelHtml({
      businessName: "فروشگاه نمونه",
      itemName: item.name,
      code: "2000000000016",
      fields: labelFieldsForTrade(trade, item),
    });

    expect(html).toContain(item.name);
    expect(html).toContain("2000000000016");
    for (const field of labelFieldsForTrade(trade, item)) {
      expect(html).toContain(field.label);
      expect(html).toContain(field.value);
    }
  });

  it("escapes HTML in the item name and field values", () => {
    const html = renderLabelHtml({
      businessName: "فروشگاه",
      itemName: "<script>alert(1)</script>",
      code: "2000000000016",
      fields: [{ label: "رنگ", value: '<img src="x">' }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('<img src="x">');
  });
});
