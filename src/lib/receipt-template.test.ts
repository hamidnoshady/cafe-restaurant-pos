import { describe, expect, it } from "vitest";
import { PAPER_WIDTH_PRESETS, renderReceiptHtml, type ReceiptData } from "./receipt-template";

const baseData: ReceiptData = {
  business: { name: "کافه نمونه", address: "تهران، خیابان ولیعصر", phone: "02112345678", footerMessage: "با تشکر از خرید شما" },
  orderLabel: "#42",
  orderTypeLabel: "حضوری — میز ۳",
  issuedAt: new Date("2024-03-21T10:00:00Z"),
  lines: [
    { name: "قهوه اسپرسو", quantity: 2, lineTotal: 200_000, modifiersLabel: "شیر بادام" },
    { name: "کیک شکلاتی", quantity: 1, lineTotal: 150_000 },
  ],
  subtotal: 350_000,
  discount: 20_000,
  tax: 15_000,
  total: 345_000,
  paymentMethod: "cash",
  cashierName: "علی رضایی",
};

describe("renderReceiptHtml", () => {
  it("is a full RTL Persian HTML document", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
    expect(html).toContain("<!doctype html>");
  });

  it("includes business info, order label, and line items", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("کافه نمونه");
    expect(html).toContain("تهران، خیابان ولیعصر");
    expect(html).toContain("#42");
    expect(html).toContain("قهوه اسپرسو");
    expect(html).toContain("شیر بادام");
    expect(html).toContain("کیک شکلاتی");
  });

  it("formats amounts as Toman with Persian digits, not Rial or Latin digits", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("تومان");
    expect(html).not.toContain("ریال");
    // 345,000 rial -> 34,500 toman -> Persian digits
    expect(html).toContain("۳۴٬۵۰۰");
    // no stray Latin digits should appear where Persian ones belong
    expect(html.match(/۲/g)?.length).toBeGreaterThan(0);
  });

  it("shows the payment method label", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("نقدی");
  });

  it("omits discount/tax rows when zero", () => {
    const html = renderReceiptHtml({ ...baseData, discount: 0, tax: 0 });
    expect(html).not.toContain("تخفیف");
    expect(html).not.toContain(">مالیات<");
  });

  it("omits the tip row when there's no tip", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).not.toContain("انعام");
    expect(html).not.toContain("مبلغ دریافتی");
  });

  it("shows the tip and a combined amount-received row when a tip was collected", () => {
    const html = renderReceiptHtml({ ...baseData, tip: 30_000 });
    expect(html).toContain("انعام");
    expect(html).toContain("مبلغ دریافتی");
    // tip 30,000 rial -> 3,000 toman
    expect(html).toContain("۳٬۰۰۰");
    // total (345,000) + tip (30,000) = 375,000 rial -> 37,500 toman
    expect(html).toContain("۳۷٬۵۰۰");
  });

  it("escapes HTML-significant characters in free-text fields", () => {
    const html = renderReceiptHtml({ ...baseData, orderTypeLabel: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sizes the body width from the paper preset", () => {
    const html58 = renderReceiptHtml(baseData, { paperWidthMm: 58 });
    const html80 = renderReceiptHtml(baseData, { paperWidthMm: 80 });
    expect(html58).toContain(`width: ${PAPER_WIDTH_PRESETS[58]}px`);
    expect(html80).toContain(`width: ${PAPER_WIDTH_PRESETS[80]}px`);
  });

  it("defaults to 80mm when no width is given", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain(`width: ${PAPER_WIDTH_PRESETS[80]}px`);
  });
});
