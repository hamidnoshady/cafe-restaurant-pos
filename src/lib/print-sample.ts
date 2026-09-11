/**
 * The sample document every preview and test print uses.
 *
 * A designer screen has to show *something* before a real sale exists, and the
 * something has to exercise every block: a long item name that wraps, a line
 * with a detail row, a discount, tax, two tenders, a note. Keeping it here —
 * pure, one object — means the template gallery, the designer preview and the
 * agent's test print all show the same document, so "it looked right in the
 * preview" is a claim about the thing that actually prints.
 */
import type { PrintBusinessInfo, PrintDocumentData } from "./print-template";

export function samplePrintDocument(
  business: Partial<PrintBusinessInfo> = {},
  overrides: Partial<PrintDocumentData> = {},
): PrintDocumentData {
  return {
    business: {
      name: business.name || "کافه نمونه",
      legalName: business.legalName ?? null,
      address: business.address ?? "تهران، خیابان ولیعصر، پلاک ۱۲",
      phone: business.phone ?? "02112345678",
      taxId: business.taxId ?? null,
      email: business.email ?? null,
      website: business.website ?? null,
      logoDataUrl: business.logoDataUrl ?? null,
    },
    number: "۱۴۰۴-۰۰۴۲",
    subtitle: "حضوری — میز ۳",
    issuedAt: new Date(),
    customer: {
      name: "شرکت نمونهٔ پارس",
      phone: "09121234567",
      address: "تهران، سعادت‌آباد، خیابان سرو",
      economicCode: "411234567890",
    },
    cashierName: "علی رضایی",
    lines: [
      {
        name: "قهوه اسپرسو دوبل",
        quantity: 2,
        detail: "شیر بادام، بدون شکر",
        unitPrice: 950_000,
        discount: 0,
        tax: 85_500,
        lineTotal: 1_900_000,
      },
      { name: "کیک شکلاتی خانگی", quantity: 1, unitPrice: 1_450_000, tax: 130_500, lineTotal: 1_450_000 },
      { name: "آب معدنی", quantity: 3, unitPrice: 200_000, tax: 54_000, lineTotal: 600_000 },
    ],
    subtotal: 3_950_000,
    discount: 200_000,
    tax: 270_000,
    total: 4_020_000,
    payments: [
      { label: "نقدی", amount: 2_000_000 },
      { label: "کارت‌خوان", amount: 2_020_000 },
    ],
    note: "سفارش برای جلسهٔ ساعت ۱۰ آماده شود.",
    footer: "با تشکر از خرید شما",
    unit: "toman",
    ...overrides,
  };
}
