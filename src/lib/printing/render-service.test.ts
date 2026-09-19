/**
 * render-service.ts — the server's render pipeline: template → HTML →
 * Chromium screenshot → monochrome raster → ESC/POS bytes, with the printer's
 * behavioural settings applied. What must never regress:
 *
 *  - the raster width follows the printer's roll (58→372px, 80→512px) and a
 *    document's own paper preset;
 *  - receipts, kitchen tickets, labels, test prints and documents all produce
 *    byte-identical output to the reference ESC/POS assembly;
 *  - the drawer kick rides along exactly when the printer is configured with
 *    «بازکردن کشوی پول»;
 *  - a sheet document is refused (sheets print through the browser dialog,
 *    never through the thermal pipeline);
 *  - the refusal model: inactive / needs-reconnect / target-less printers are
 *    refused before any rendering happens.
 *
 * The Chromium render is mocked; its own behaviour is pinned in raster.test.ts
 * and escpos.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { buildDrawerKickJob, buildPrintJob, packMonochromeRaster } from "../escpos";
import * as chromium from "./chromium";
import { decodePngToGrayscale } from "./raster";
import { buildDraftTestBytes, buildJobBytes, printerRefusal, type StoredPrinter } from "./render-service";
import type { ReceiptData } from "../receipt-template";
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { LabelData } from "../label-template";

vi.mock("./chromium", () => ({
  renderHtmlToPng: vi.fn(),
}));

/** A real (tiny) PNG so the raster path exercises the actual raster.ts decode. */
function tinyPngBuffer(width = 8, height = 2): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    // Alternate black/white so the packed raster is a known checkerboard.
    const v = i % 2 === 0 ? 0 : 255;
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** The job bytes the raster path must produce for `png` on a printer. */
function expectedJobFor(png: Buffer, opts: { kickDrawer?: boolean } = {}): Buffer {
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  return buildPrintJob(raster, { kickDrawer: opts.kickDrawer, cut: true });
}

const RECEIPT: ReceiptData = {
  business: { name: "کافه تست" },
  orderLabel: "#42",
  orderTypeLabel: "حضوری",
  issuedAt: new Date("2026-01-15T10:00:00Z"),
  lines: [{ name: "اسپرسو", quantity: 1, lineTotal: 500_000 }],
  subtotal: 500_000,
  discount: 0,
  tax: 0,
  total: 500_000,
};

const TICKET: KitchenTicketData = {
  label: "میز ۳",
  orderTypeLabel: "حضوری",
  sentAt: new Date("2026-01-15T10:00:00Z"),
  lines: [{ name: "پاستا", quantity: 2 }],
};

const LABEL: LabelData = {
  businessName: "کافه تست",
  itemName: "قهوه",
  code: "1234567890",
  fields: [],
};

function printer(connection: StoredPrinter["connection"], kind: "receipt" | "kitchen" = "receipt"): StoredPrinter {
  return { id: "p1", name: "چاپگر", kind, connection, is_active: true };
}

let png: Buffer;

beforeEach(() => {
  vi.clearAllMocks();
  png = tinyPngBuffer();
  vi.mocked(chromium.renderHtmlToPng).mockResolvedValue(png);
});

describe("raster width", () => {
  it("screenshots at 512px for 80mm and 372px for 58mm printers", async () => {
    await buildJobBytes(printer({ type: "network", ip: "10.0.0.9", paperWidthMm: 80 }), { type: "receipt", receipt: RECEIPT });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(512);

    await buildJobBytes(printer({ type: "network", ip: "10.0.0.9", paperWidthMm: 58 }), { type: "receipt", receipt: RECEIPT });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[1][1]).toBe(372);
  });

  it("defaults an old-shaped connection (no width) to 80mm/512px", async () => {
    await buildJobBytes(printer({ type: "network", ip: "10.0.0.1" }), { type: "receipt", receipt: RECEIPT });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(512);
  });

  it("prefers a document paper's own raster width", async () => {
    await buildJobBytes(printer({ type: "network", ip: "x", paperWidthMm: 80 }), {
      type: "document",
      html: "<html><body>x</body></html>",
      paper: "thermal58",
    });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(372);
  });
});

describe("job rendering", () => {
  it("renders a receipt to the reference ESC/POS bytes", async () => {
    const bytes = await buildJobBytes(printer({ type: "network", ip: "10.0.0.9" }), { type: "receipt", receipt: RECEIPT });
    expect(bytes).toEqual(expectedJobFor(png));
  });

  it("renders a kitchen ticket with the same pipeline", async () => {
    const bytes = await buildJobBytes(printer({ type: "windows", systemName: "EPSON" }, "kitchen"), {
      type: "kitchen-ticket",
      ticket: TICKET,
    });
    expect(bytes).toEqual(expectedJobFor(png));
  });

  it("renders a label", async () => {
    const bytes = await buildJobBytes(printer({ type: "network", ip: "10.0.0.9" }), { type: "label", label: LABEL });
    expect(bytes).toEqual(expectedJobFor(png));
  });

  it("renders the sample test print for both kinds", async () => {
    await buildJobBytes(printer({ type: "windows", systemName: "EPSON" }), { type: "test", kind: "receipt" });
    await buildJobBytes(printer({ type: "windows", systemName: "EPSON" }), { type: "test", kind: "kitchen" });
    expect(chromium.renderHtmlToPng).toHaveBeenCalledTimes(2);
    const html = vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0];
    expect(html).toContain("کافه نمونه"); // the sample receipt
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[1][0]).not.toBe(html); // the sample ticket differs
  });

  it("renders a thermal document (the template preview print)", async () => {
    const bytes = await buildJobBytes(printer({ type: "network", ip: "x" }), {
      type: "document",
      html: "<html><body>invoice</body></html>",
      paper: "thermal80",
    });
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][0]).toContain("invoice");
    expect(bytes).toEqual(expectedJobFor(png));
  });

  it("refuses a sheet document — sheets print through the browser dialog, not the thermal pipeline", async () => {
    await expect(
      buildJobBytes(printer({ type: "windows", systemName: "HP LaserJet" }), {
        type: "document",
        html: "<html><body>x</body></html>",
        paper: "a4",
      }),
    ).rejects.toThrow("sheet_documents_print_in_the_browser");
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
});

describe("cash drawer", () => {
  it("kicks the drawer exactly when the printer is configured to", async () => {
    const withKick = await buildJobBytes(printer({ type: "network", ip: "x", openDrawer: true }), { type: "receipt", receipt: RECEIPT });
    expect(withKick).toEqual(expectedJobFor(png, { kickDrawer: true }));

    const withoutKick = await buildJobBytes(printer({ type: "network", ip: "x", openDrawer: false }), { type: "receipt", receipt: RECEIPT });
    expect(withoutKick).toEqual(expectedJobFor(png));
  });

  it("a drawer-kick job is the bare kick command", async () => {
    const bytes = await buildJobBytes(printer({ type: "windows", systemName: "E" }), { type: "drawer-kick" });
    expect(bytes).toEqual(buildDrawerKickJob());
    expect(chromium.renderHtmlToPng).not.toHaveBeenCalled();
  });
});

describe("the draft test print (the add-printer wizard)", () => {
  it("renders the sample document at the chosen roll width", async () => {
    await buildDraftTestBytes("receipt", 58);
    await buildDraftTestBytes("kitchen", 80);
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[0][1]).toBe(372);
    expect(vi.mocked(chromium.renderHtmlToPng).mock.calls[1][1]).toBe(512);
  });
});

describe("printerRefusal", () => {
  it("refuses an inactive printer before any rendering", () => {
    const p = printer({ type: "network", ip: "x" });
    p.is_active = false;
    expect(printerRefusal(p)).toBe("printer_inactive");
  });

  it("refuses a reconnect-required legacy printer", () => {
    expect(printerRefusal(printer({ needsReconnect: true, legacyTransport: "webusb", usbVendorId: 0x04b8 }))).toBe(
      "reconnect_required",
    );
  });

  it("refuses a printer whose stored target is incomplete", () => {
    expect(printerRefusal(printer({ type: "windows" }))).toBe("invalid_printer");
    expect(printerRefusal(printer({ type: "network", ip: "" }))).toBe("invalid_printer");
  });

  it("accepts a healthy printer", () => {
    expect(printerRefusal(printer({ type: "windows", systemName: "EPSON" }))).toBeNull();
    expect(printerRefusal(printer({ type: "network", ip: "10.0.0.9" }))).toBeNull();
  });
});
