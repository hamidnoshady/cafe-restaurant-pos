/**
 * system-print/service.ts — the one shared implementation of "put this
 * document on that printer", used by both the standalone print agent and the
 * app server's /api/print/* routes. These tests pin the routing decisions
 * that make the two callers interchangeable:
 *
 *  - which transport gets the bytes (network socket / spooler / device path),
 *  - which paper takes the raster path vs the PDF-to-sheet path,
 *  - the raster width chosen for each paper/connection shape,
 *  - that the client-side transports (webusb, browser) are refused with the
 *    exact error strings the callers branch on,
 *  - that buildJobBytes renders WITHOUT sending (the WebUSB middleman path),
 *    and that its output is byte-identical to what the sending path produces.
 *
 * All I/O boundaries (Chromium render, spooler, socket, discovery) are
 * mocked; their own behaviour is pinned in their own tests (png.test.ts,
 * escpos.test.ts) or is process/hardware I/O with nothing unit-testable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { buildDrawerKickJob, buildPrintJob, packMonochromeRaster } from "../escpos";
import { decodePngToGrayscale } from "./png";
import * as render from "./render";
import * as spooler from "./spooler";
import * as transport from "./transport";
import * as discovery from "./discovery";
import {
  buildJobBytes,
  kickDrawerJob,
  printDocumentJob,
  printKitchenTicketJob,
  printLabelJob,
  printReceiptJob,
  printTestJob,
  probeConnection,
} from "./service";
import type { ReceiptData } from "../receipt-template";
import type { KitchenTicketData } from "../kitchen-ticket-template";
import type { LabelData } from "../label-template";

vi.mock("./render", () => ({
  renderHtmlToPng: vi.fn(),
  renderHtmlToPdf: vi.fn(),
}));
vi.mock("./spooler", () => ({
  sendRawToSystemPrinter: vi.fn().mockResolvedValue(undefined),
  sendDocumentToSystemPrinter: vi.fn().mockResolvedValue(undefined),
  sendRawToDevice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./transport", () => ({
  sendToPrinter: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./discovery", () => ({
  listSystemPrinters: vi.fn().mockResolvedValue([]),
  scanLanPrinters: vi.fn().mockResolvedValue([]),
}));

/** A real (tiny) PNG so the raster path exercises the actual png.ts decode. */
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

/** The job bytes the raster path must produce for `png` on `connection`. */
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

let png: Buffer;

beforeEach(() => {
  vi.clearAllMocks();
  png = tinyPngBuffer();
  vi.mocked(render.renderHtmlToPng).mockResolvedValue(png);
  vi.mocked(render.renderHtmlToPdf).mockResolvedValue(Buffer.from("%PDF-fake"));
});

describe("transport routing (sendBytes)", () => {
  it("sends a receipt to a network printer over the raw socket, at ip:port", async () => {
    await printReceiptJob({ transport: "network", ip: "10.0.0.9", port: 9101 }, RECEIPT);
    expect(transport.sendToPrinter).toHaveBeenCalledTimes(1);
    const [ip, port, job] = vi.mocked(transport.sendToPrinter).mock.calls[0];
    expect(ip).toBe("10.0.0.9");
    expect(port).toBe(9101);
    expect(job).toEqual(expectedJobFor(png));
    expect(spooler.sendRawToSystemPrinter).not.toHaveBeenCalled();
    expect(spooler.sendRawToDevice).not.toHaveBeenCalled();
  });

  it("defaults the network port to 9100", async () => {
    await printReceiptJob({ transport: "network", ip: "10.0.0.9" }, RECEIPT);
    expect(vi.mocked(transport.sendToPrinter).mock.calls[0][1]).toBe(9100);
  });

  it("sends to a system printer through the spooler, by queue name", async () => {
    await printReceiptJob({ transport: "system", systemName: "EPSON TM-T20III" }, RECEIPT);
    expect(spooler.sendRawToSystemPrinter).toHaveBeenCalledTimes(1);
    const [queue, job] = vi.mocked(spooler.sendRawToSystemPrinter).mock.calls[0];
    expect(queue).toBe("EPSON TM-T20III");
    expect(job).toEqual(expectedJobFor(png));
    expect(transport.sendToPrinter).not.toHaveBeenCalled();
  });

  it("sends to a usb printer by raw device path", async () => {
    await printReceiptJob({ transport: "usb", devicePath: "/dev/usb/lp0" }, RECEIPT);
    expect(spooler.sendRawToDevice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spooler.sendRawToDevice).mock.calls[0][0]).toBe("/dev/usb/lp0");
  });

  it("refuses the client-side transports with the exact errors callers branch on", async () => {
    await expect(printReceiptJob({ transport: "webusb", usbVendorId: 0x04b8 }, RECEIPT)).rejects.toThrow(
      "webusb_transport_is_client_side",
    );
    await expect(printReceiptJob({ transport: "browser" }, RECEIPT)).rejects.toThrow(
      "browser_transport_is_client_side",
    );
    expect(transport.sendToPrinter).not.toHaveBeenCalled();
    expect(spooler.sendRawToSystemPrinter).not.toHaveBeenCalled();
    expect(spooler.sendRawToDevice).not.toHaveBeenCalled();
  });
});

describe("raster width", () => {
  it("screenshots at 512px for 80mm and 372px for 58mm connections", async () => {
    await printReceiptJob({ transport: "network", ip: "x", paperWidthMm: 80 }, RECEIPT);
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[0][1]).toBe(512);

    await printReceiptJob({ transport: "network", ip: "x", paperWidthMm: 58 }, RECEIPT);
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[1][1]).toBe(372);
  });

  it("prefers the paper preset's own raster width for a document job", async () => {
    // thermal58's preset is 372 even when the connection says 80mm.
    await printDocumentJob({ transport: "network", ip: "x", paperWidthMm: 80 }, "<html><body>x</body></html>", "thermal58");
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[0][1]).toBe(372);
  });

  it("defaults an old-shaped connection (no width) to 80mm/512px", async () => {
    await printReceiptJob({ ip: "10.0.0.1" }, RECEIPT);
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[0][1]).toBe(512);
  });
});

describe("printDocumentJob — sheets vs rolls", () => {
  it("rasters a thermal paper", async () => {
    await printDocumentJob({ transport: "network", ip: "x" }, "<html><body>x</body></html>", "thermal80");
    expect(render.renderHtmlToPng).toHaveBeenCalled();
    expect(render.renderHtmlToPdf).not.toHaveBeenCalled();
    expect(transport.sendToPrinter).toHaveBeenCalled();
  });

  it("renders a sheet paper to PDF and spools it to the system queue with the connection's copies", async () => {
    await printDocumentJob(
      { transport: "system", systemName: "HP LaserJet", copies: 2 },
      "<html><body>invoice</body></html>",
      "a4",
    );
    expect(render.renderHtmlToPdf).toHaveBeenCalledWith("<html><body>invoice</body></html>");
    expect(spooler.sendDocumentToSystemPrinter).toHaveBeenCalledWith(
      "HP LaserJet",
      Buffer.from("%PDF-fake"),
      { copies: 2 },
    );
    expect(render.renderHtmlToPng).not.toHaveBeenCalled();
  });

  it("refuses a sheet on anything but a system printer", async () => {
    await expect(printDocumentJob({ transport: "network", ip: "x" }, "<html></html>", "a4")).rejects.toThrow(
      "sheet_printing_needs_a_system_printer",
    );
    expect(render.renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it("with no paper key, falls back to the connection's driverMode", async () => {
    await printDocumentJob({ transport: "system", systemName: "Q", driverMode: "document" }, "<html></html>", undefined);
    expect(spooler.sendDocumentToSystemPrinter).toHaveBeenCalled();

    await printDocumentJob({ transport: "system", systemName: "Q", driverMode: "raster" }, "<html></html>", undefined);
    expect(render.renderHtmlToPng).toHaveBeenCalledTimes(1);
  });
});

describe("drawer", () => {
  it("honours the connection's openDrawer on a receipt raster", async () => {
    await printReceiptJob({ transport: "network", ip: "x", openDrawer: true }, RECEIPT);
    const job = vi.mocked(transport.sendToPrinter).mock.calls[0][2];
    expect(job).toEqual(expectedJobFor(png, { kickDrawer: true }));
  });

  it("kickDrawerJob sends exactly the init+kick byte pair, no raster", async () => {
    await kickDrawerJob({ transport: "network", ip: "x" });
    expect(render.renderHtmlToPng).not.toHaveBeenCalled();
    expect(vi.mocked(transport.sendToPrinter).mock.calls[0][2]).toEqual(buildDrawerKickJob());
  });
});

describe("HTML fed to the renderer", () => {
  it("kitchen tickets and labels render their own templates", async () => {
    await printKitchenTicketJob({ transport: "network", ip: "x" }, TICKET);
    const ticketHtml = vi.mocked(render.renderHtmlToPng).mock.calls[0][0];
    expect(ticketHtml).toContain("میز ۳");

    await printLabelJob({ transport: "network", ip: "x" }, LABEL);
    const labelHtml = vi.mocked(render.renderHtmlToPng).mock.calls[1][0];
    expect(labelHtml).toContain("1234567890");
  });

  it("test prints render the sample receipt or the sample ticket by kind", async () => {
    await printTestJob({ transport: "network", ip: "x" }, "receipt");
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[0][0]).toContain("چاپ آزمایشی");

    await printTestJob({ transport: "network", ip: "x" }, "kitchen");
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[1][0]).toContain("آزمایشی");
    expect(transport.sendToPrinter).toHaveBeenCalledTimes(2);
  });
});

describe("buildJobBytes — rendering without sending (the WebUSB half)", () => {
  it("returns the same bytes the sending path would have sent, and sends nothing", async () => {
    const connection = { transport: "webusb" as const, usbVendorId: 0x04b8, paperWidthMm: 58 as const };
    const bytes = await buildJobBytes(connection, { op: "receipt", receipt: RECEIPT });
    expect(bytes).toEqual(expectedJobFor(png));
    // The whole point: nothing left the process.
    expect(transport.sendToPrinter).not.toHaveBeenCalled();
    expect(spooler.sendRawToSystemPrinter).not.toHaveBeenCalled();
    expect(spooler.sendRawToDevice).not.toHaveBeenCalled();
    expect(spooler.sendDocumentToSystemPrinter).not.toHaveBeenCalled();
    // And it used the connection's own paper width.
    expect(vi.mocked(render.renderHtmlToPng).mock.calls[0][1]).toBe(372);
  });

  it("renders every raster op", async () => {
    const connection = { transport: "webusb" as const, usbVendorId: 1 };
    await buildJobBytes(connection, { op: "document", html: "<html><body>x</body></html>", paper: "thermal80" });
    await buildJobBytes(connection, { op: "kitchen-ticket", ticket: TICKET });
    await buildJobBytes(connection, { op: "label", label: LABEL });
    await buildJobBytes(connection, { op: "test", kind: "kitchen" });
    expect(render.renderHtmlToPng).toHaveBeenCalledTimes(4);
    expect(transport.sendToPrinter).not.toHaveBeenCalled();
  });

  it("drawer-kick needs no rendering at all", async () => {
    const bytes = await buildJobBytes({ transport: "webusb", usbVendorId: 1 }, { op: "drawer-kick" });
    expect(bytes).toEqual(buildDrawerKickJob());
    expect(render.renderHtmlToPng).not.toHaveBeenCalled();
  });

  it("refuses a sheet document — a PDF has no meaning on a raw ESC/POS device", async () => {
    await expect(
      buildJobBytes({ transport: "webusb", usbVendorId: 1 }, { op: "document", html: "<html></html>", paper: "a4" }),
    ).rejects.toThrow("sheet_printing_needs_a_system_printer");
  });
});

describe("probeConnection", () => {
  it("browser and usb are unverifiable-but-ok; webusb defers to the browser", async () => {
    expect(await probeConnection({ transport: "browser" })).toEqual({ reachable: true, detail: "browser" });
    expect(await probeConnection({ transport: "usb", devicePath: "USB001" })).toEqual({
      reachable: true,
      detail: "unverifiable",
    });
    expect(await probeConnection({ transport: "webusb", usbVendorId: 1 })).toEqual({
      reachable: true,
      detail: "unverifiable_from_server",
    });
  });

  it("a system printer is reachable exactly when its queue name appears in the OS list", async () => {
    vi.mocked(discovery.listSystemPrinters).mockResolvedValue([
      { name: "TM-T20", driver: null, port: null, isDefault: false, status: "Normal", likelyThermal: true },
    ]);
    expect(await probeConnection({ transport: "system", systemName: "TM-T20" })).toEqual({
      reachable: true,
      detail: "Normal",
    });
    expect((await probeConnection({ transport: "system", systemName: "Other" })).reachable).toBe(false);
  });
});
