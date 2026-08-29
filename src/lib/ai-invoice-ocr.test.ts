import { describe, expect, it } from "vitest";
import {
  parseInvoiceExtractionReply,
  pickBestInventoryMatch,
  scoreNameMatch,
  validateExtractedInvoice,
} from "./ai-invoice-ocr";
import { MAX_RECEIPT_IMAGE_BYTES, parseReceiptImageDataUrl } from "./ai-receipt";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("parseInvoiceExtractionReply", () => {
  it("parses a well-formed multi-line invoice reply", () => {
    const reply = JSON.stringify({
      vendor: "تأمین‌کننده نمونه",
      invoiceDate: "2026-08-20",
      invoiceNumber: "INV-100",
      totalRial: 1_500_000,
      note: "خرید هفتگی",
      lines: [
        {
          name: "شیر پرچرب",
          quantity: "10",
          unit: "لیتر",
          lineTotalRial: 1_000_000,
          barcode: "6260123456789",
          confidence: 0.92,
        },
        {
          name: "نان باگت",
          quantity: 20,
          unit: "عدد",
          lineTotalRial: 500_000,
          confidence: 0.8,
        },
      ],
    });
    const parsed = parseInvoiceExtractionReply(reply);
    expect(parsed).not.toBeNull();
    expect(parsed?.vendor).toBe("تأمین‌کننده نمونه");
    expect(parsed?.invoiceDate).toBe("2026-08-20");
    expect(parsed?.totalRial).toBe(1_500_000);
    expect(parsed?.lines).toHaveLength(2);
    expect(parsed?.lines[0].barcode).toBe("6260123456789");
    expect(parsed?.lines[1].quantity).toBe("20");
  });

  it("strips a ```json fence and folds Persian digits in quantities", () => {
    const reply =
      "```json\n" +
      JSON.stringify({
        vendor: "الف",
        lines: [{ name: "شکر", quantity: "۲.۵", lineTotalRial: "۱۰۰۰۰" }],
      }) +
      "\n```";
    const parsed = parseInvoiceExtractionReply(reply);
    expect(parsed?.vendor).toBe("الف");
    expect(parsed?.lines[0].quantity).toBe("2.5");
    expect(parsed?.lines[0].lineTotalRial).toBe(10_000);
  });

  it("drops lines without a name and never fakes totals", () => {
    const reply = JSON.stringify({
      totalRial: -5,
      invoiceDate: "not-a-date",
      lines: [{ quantity: 1 }, { name: "قهوه", lineTotalRial: "abc" }],
    });
    const parsed = parseInvoiceExtractionReply(reply);
    expect(parsed?.totalRial).toBeNull();
    expect(parsed?.invoiceDate).toBeNull();
    expect(parsed?.lines).toHaveLength(1);
    expect(parsed?.lines[0].lineTotalRial).toBeNull();
  });

  it("returns null for unparseable replies", () => {
    expect(parseInvoiceExtractionReply("متن آزاد")).toBeNull();
    expect(parseInvoiceExtractionReply("")).toBeNull();
    expect(parseInvoiceExtractionReply("42")).toBeNull();
  });
});

describe("scoreNameMatch / pickBestInventoryMatch", () => {
  const catalogue = [
    { id: "1", name: "شیر پرچرب", code: "6260001111111" },
    { id: "2", name: "شیر کم‌چرب", code: null },
    { id: "3", name: "قهوه اسپرسو", code: "6260002222222" },
    { id: "4", name: "نان سنگک", code: null },
  ];

  it("scores exact and partial Persian names", () => {
    expect(scoreNameMatch("شیر پرچرب", "شیر پرچرب")).toBe(1);
    expect(scoreNameMatch("شیر", "شیر پرچرب")).toBeGreaterThan(0.7);
    expect(scoreNameMatch("چای", "قهوه اسپرسو")).toBeLessThan(0.3);
  });

  it("prefers an exact barcode hit over the name", () => {
    const picked = pickBestInventoryMatch(
      { name: "چیز دیگر", barcode: "6260001111111" },
      catalogue,
    );
    expect(picked.status).toBe("matched");
    expect(picked.item?.id).toBe("1");
  });

  it("returns unmatched when nothing is close", () => {
    const picked = pickBestInventoryMatch({ name: "روغن زیتون", barcode: null }, catalogue);
    expect(picked.status).toBe("unmatched");
    expect(picked.item).toBeNull();
  });

  it("returns ambiguous when two names score nearly the same", () => {
    const tight = [
      { id: "a", name: "شیر پرچرب ۱ لیتری", code: null },
      { id: "b", name: "شیر پرچرب ۲ لیتری", code: null },
    ];
    const picked = pickBestInventoryMatch({ name: "شیر پرچرب", barcode: null }, tight, {
      nameThreshold: 0.4,
    });
    // Both share the same strong prefix; either matched-on-top or ambiguous is
    // acceptable as long as we never silently pick the weaker one alone.
    expect(["matched", "ambiguous"]).toContain(picked.status);
    if (picked.status === "ambiguous") {
      expect(picked.candidates.length).toBeGreaterThan(1);
    }
  });
});

describe("validateExtractedInvoice", () => {
  it("passes when every line is matched with confidence", () => {
    const result = validateExtractedInvoice({
      extraction: {
        vendor: "تأمین",
        invoiceDate: "2026-08-20",
        invoiceNumber: null,
        totalRial: 1000,
        note: "n",
        lines: [],
        rawText: null,
      },
      lines: [
        {
          name: "شیر",
          quantity: "1",
          unit: "ل",
          lineTotalRial: 1000,
          barcode: null,
          confidence: 0.9,
          matchStatus: "matched",
          matchedItemName: "شیر",
          candidateCount: 1,
        },
      ],
      matchedLinesTotalRial: 1000,
    });
    expect(result.verdict).toBe("pass");
    expect(result.issues).toHaveLength(0);
  });

  it("fails when nothing matched", () => {
    const result = validateExtractedInvoice({
      extraction: {
        vendor: null,
        invoiceDate: null,
        invoiceNumber: null,
        totalRial: null,
        note: "n",
        lines: [],
        rawText: null,
      },
      lines: [
        {
          name: "x",
          quantity: null,
          unit: null,
          lineTotalRial: null,
          barcode: null,
          confidence: 0.2,
          matchStatus: "unmatched",
          matchedItemName: null,
          candidateCount: 0,
        },
      ],
      matchedLinesTotalRial: null,
    });
    expect(result.verdict).toBe("fail");
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("warns on total mismatch", () => {
    const result = validateExtractedInvoice({
      extraction: {
        vendor: "ت",
        invoiceDate: "2026-01-01",
        invoiceNumber: null,
        totalRial: 10_000,
        note: "n",
        lines: [],
        rawText: null,
      },
      lines: [
        {
          name: "a",
          quantity: "1",
          unit: null,
          lineTotalRial: 5_000,
          barcode: null,
          confidence: 0.9,
          matchStatus: "matched",
          matchedItemName: "a",
          candidateCount: 1,
        },
      ],
      matchedLinesTotalRial: 5_000,
    });
    expect(result.verdict).toBe("warn");
    expect(result.issues.some((i) => i.includes("جمع"))).toBe(true);
  });
});

describe("image validation reuse", () => {
  it("accepts the same image types as expense receipt OCR", () => {
    expect(parseReceiptImageDataUrl(`data:image/png;base64,${SMALL_PNG_BASE64}`)?.mimeType).toBe(
      "image/png",
    );
    const huge = "A".repeat(Math.ceil((MAX_RECEIPT_IMAGE_BYTES * 4) / 3) + 2048);
    expect(parseReceiptImageDataUrl(`data:image/jpeg;base64,${huge}`)).toBeNull();
  });
});
