/**
 * The server half of thermal printing: load the saved printer for the
 * authenticated branch, render the canonical document, and emit ESC/POS
 * bytes. Server-only (DB + Chromium); it never reaches restaurant hardware —
 * the bytes go back to the browser, which delivers them through the local
 * Cafe POS connector. That split is the architecture: the app server owns
 * rendering (Persian/RTL shaping needs its Chromium pipeline), the cashier's
 * machine owns the printers.
 */
import { buildDrawerKickJob, buildPrintJob, packMonochromeRaster } from "../escpos";
import { renderKitchenTicketHtml, type KitchenTicketData } from "../kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../label-template";
import { PAPERS, type PaperKey } from "../print-template";
import { PAPER_WIDTH_PRESETS, renderReceiptHtml, type ReceiptData } from "../receipt-template";
import { query } from "../db";
import { normalizeStoredConnection, resolvedPaperWidthMm, type StoredPrinter } from "./types";
import { decodePngToGrayscale } from "./raster";
import { renderHtmlToPng } from "./chromium";

export type { StoredPrinter } from "./types";

/** The sample content a test print prints — a real receipt/ticket, real shaping. */
const SAMPLE_RECEIPT: ReceiptData = {
  business: { name: "کافه نمونه", footerMessage: "این یک چاپ آزمایشی است" },
  orderLabel: "#0",
  orderTypeLabel: "چاپ آزمایشی",
  issuedAt: new Date(),
  lines: [{ name: "آیتم نمونه", quantity: 1, lineTotal: 100_000 }],
  subtotal: 100_000,
  discount: 0,
  tax: 0,
  total: 100_000,
};

const SAMPLE_TICKET: KitchenTicketData = {
  label: "چاپ آزمایشی",
  orderTypeLabel: "آزمایشی",
  sentAt: new Date(),
  lines: [{ name: "آیتم نمونه", quantity: 1 }],
};

/** A print job, described by data rather than by rendered output. */
export type PrintJob =
  | { type: "receipt"; receipt: ReceiptData }
  | { type: "kitchen-ticket"; ticket: KitchenTicketData }
  | { type: "label"; label: LabelData }
  | { type: "test"; kind: "receipt" | "kitchen" }
  | { type: "drawer-kick" }
  /** A rendered template document (the designer/gallery preview print). Thermal papers only. */
  | { type: "document"; html: string; paper: PaperKey };

/**
 * Load one saved printer, scoped to the branch the request is printing for.
 * A printer ID from another branch simply does not exist from here — the
 * caller gets `null` and answers `printer_not_found`, so a hand-edited
 * request can never point the pipeline at another branch's hardware.
 */
export async function loadPrinterForJob(locationId: string, printerId: string): Promise<StoredPrinter | null> {
  const { rows } = await query<StoredPrinter>(
    "SELECT id, name, kind, connection, is_active FROM printers WHERE id = $1 AND location_id = $2",
    [printerId, locationId],
  );
  const printer = rows[0] ?? null;
  if (!printer) return null;
  printer.connection = normalizeStoredConnection(printer.connection);
  return printer;
}

/** The canonical reason a loaded printer cannot print, or null when it can. */
export function printerRefusal(printer: StoredPrinter): "printer_inactive" | "reconnect_required" | "invalid_printer" | null {
  if (!printer.is_active) return "printer_inactive";
  if (printer.connection.needsReconnect) return "reconnect_required";
  const target = printer.connection;
  if (target.type === "windows" && (!target.systemName || target.systemName.trim() === "")) return "invalid_printer";
  if (target.type === "network" && (!target.ip || target.ip.trim() === "")) return "invalid_printer";
  return null;
}

/** Raster width for a job: the document paper's own preset, else the printer's roll width. */
function rasterWidthFor(printer: StoredPrinter, paper?: PaperKey): number {
  if (paper && PAPERS[paper]?.rasterPx) return PAPERS[paper].rasterPx!;
  return PAPER_WIDTH_PRESETS[resolvedPaperWidthMm(printer.connection)];
}

/** ESC/POS raster job bytes: screenshot the HTML and pack it — no sending, ever. */
async function rasterJobBytes(
  printer: StoredPrinter,
  html: string,
  opts: { kickDrawer?: boolean; paper?: PaperKey } = {},
): Promise<Buffer> {
  const png = await renderHtmlToPng(html, rasterWidthFor(printer, opts.paper));
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  return buildPrintJob(raster, { kickDrawer: opts.kickDrawer ?? printer.connection.openDrawer === true, cut: true });
}

/**
 * Render a job to its canonical ESC/POS byte stream. Pure pipeline:
 * template → HTML (with the Persian font embedded) → Chromium screenshot →
 * monochrome raster → GS v 0 commands, plus feed/cut and — for printers
 * configured with «بازکردن کشوی پول» — the drawer kick.
 */
export async function buildJobBytes(printer: StoredPrinter, job: PrintJob): Promise<Buffer> {
  const width = { paperWidthMm: resolvedPaperWidthMm(printer.connection) };
  switch (job.type) {
    case "document": {
      const spec = PAPERS[job.paper];
      if (spec.kind !== "thermal" && spec.kind !== "label") {
        // Sheets never take the thermal path; the caller prints those
        // through the browser's own dialog and never reaches this branch.
        throw new Error("sheet_documents_print_in_the_browser");
      }
      return rasterJobBytes(printer, job.html, { paper: job.paper });
    }
    case "receipt":
      return rasterJobBytes(printer, renderReceiptHtml(job.receipt, width));
    case "kitchen-ticket":
      return rasterJobBytes(printer, renderKitchenTicketHtml(job.ticket, width));
    case "label":
      return rasterJobBytes(printer, renderLabelHtml(job.label));
    case "test":
      return rasterJobBytes(
        printer,
        job.kind === "kitchen"
          ? renderKitchenTicketHtml(SAMPLE_TICKET, width)
          : renderReceiptHtml(SAMPLE_RECEIPT, width),
      );
    case "drawer-kick":
      return buildDrawerKickJob();
  }
}

/** The unsaved-draft test print: same sample document, chosen roll width, no saved printer yet. */
export async function buildDraftTestBytes(kind: "receipt" | "kitchen", paperWidthMm: 58 | 80): Promise<Buffer> {
  const draftPrinter: StoredPrinter = {
    id: "draft",
    name: "draft",
    kind,
    is_active: true,
    connection: { type: "network", ip: "0.0.0.0", paperWidthMm },
  };
  return buildJobBytes(draftPrinter, { type: "test", kind });
}
