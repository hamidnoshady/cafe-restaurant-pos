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
import { type KitchenTicketData } from "../kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../label-template";
import { builtInTemplate, PAPERS, renderPrintTemplate, type PaperKey, type PrintTemplate } from "../print-template";
import { PAPER_WIDTH_PRESETS, type ReceiptData } from "../receipt-template";
import { query } from "../db";
import { kitchenToPrintDocument, receiptToPrintDocument, type PrintBranding } from "./document-bridge";
import { isSheetPaper, paperOfPrinter, printerClassFor, resolvePrinter, type PrinterPurpose, type RoutingPrinter } from "./routing";
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
  | { type: "receipt"; receipt: ReceiptData; kickDrawer?: boolean }
  | { type: "kitchen-ticket"; ticket: KitchenTicketData }
  | { type: "label"; label: LabelData }
  | { type: "test"; kind: "receipt" | "kitchen" | "document" }
  | { type: "drawer-kick" }
  /** A rendered template document. Thermal papers become ESC/POS; sheets become a page image. */
  | { type: "document"; html: string; paper: PaperKey };

export interface PreparedPrint {
  /** `raw` is ESC/POS. `page` is a PNG the Windows driver prints without a dialog. */
  delivery: "raw" | "page";
  bytes: Buffer;
}

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

function asPurpose(kind: string): PrinterPurpose {
  if (kind === "kitchen" || kind === "label" || kind === "document" || kind === "receipt") return kind;
  return "receipt";
}

/** Pick the branch printer for a document. An explicit id wins; otherwise rules, then the default. */
export async function resolvePrinterForLocation(
  locationId: string,
  documentType: "receipt" | "invoice" | "kitchen" | "label",
  requestedPrinterId?: string | null,
): Promise<StoredPrinter | null> {
  const { rows } = await query<StoredPrinter>(
    "SELECT id, name, kind, connection, is_active FROM printers WHERE location_id = $1",
    [locationId],
  );
  const printers: RoutingPrinter[] = rows.map((row) => {
    const connection = normalizeStoredConnection(row.connection);
    const purpose = asPurpose(String(row.kind));
    const paper = paperOfPrinter(connection);
    return {
      id: String(row.id),
      name: String(row.name),
      purpose,
      printerClass: printerClassFor(purpose, paper),
      isActive: row.is_active !== false,
      isDefault: connection.isDefault === true,
      needsReconnect: connection.needsReconnect === true,
      supportsDrawer: connection.openDrawer === true,
      paper,
    };
  });
  let rules: { documentType: typeof documentType; printerId: string | null; fallbackPrinterId: string | null; templateKey: string | null; templateId: string | null }[] = [];
  try {
    const loaded = await query<{ document_type: string; printer_id: string | null; fallback_printer_id: string | null; template_key: string | null; template_id: string | null }>(
      "SELECT document_type, printer_id, fallback_printer_id, template_key, template_id FROM print_rules WHERE location_id = $1",
      [locationId],
    );
    rules = loaded.rows
      .filter((row) => row.document_type === "receipt" || row.document_type === "invoice" || row.document_type === "kitchen" || row.document_type === "label")
      .map((row) => ({
        documentType: row.document_type as typeof documentType,
        printerId: row.printer_id,
        fallbackPrinterId: row.fallback_printer_id,
        templateKey: row.template_key,
        templateId: row.template_id,
      }));
  } catch (err) {
    console.error("print rules unavailable", err);
  }
  const resolved = resolvePrinter({ documentType, printers, rules, requestedPrinterId });
  const chosen = resolved.printer ?? printers.find((printer) => printer.isActive && !printer.needsReconnect && printer.purpose === (documentType === "invoice" ? "document" : documentType === "kitchen" ? "kitchen" : documentType === "label" ? "label" : "receipt"));
  if (!chosen) return null;
  return loadPrinterForJob(locationId, chosen.id);
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
  if (paper && isSheetPaper(paper)) return paper === "a5" ? 559 : 794;
  return PAPER_WIDTH_PRESETS[resolvedPaperWidthMm(printer.connection)];
}

const TEST_HTML = `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"></head><body style="font-family:Vazirmatn,sans-serif;padding:24px">
<h1>چاپ آزمایشی</h1>
<p>اگر این برگه خواناست، چاپ به‌درستی تنظیم شده است.</p>
</body></html>`;

function templateFor(printer: StoredPrinter, doc: "receipt" | "kitchen" | "invoice"): PrintTemplate {
  const stored = printer.connection.templateKey;
  const chosen = typeof stored === "string" ? builtInTemplate(stored) : null;
  if (chosen && chosen.docType === doc) return chosen;
  const paper = paperOfPrinter(printer.connection);
  if (doc === "kitchen") return builtInTemplate("thermal80-kitchen")!;
  if (doc === "invoice" || isSheetPaper(paper)) return builtInTemplate(paper === "a5" ? "a5-invoice" : "a4-invoice")!;
  return builtInTemplate(paper === "thermal58" ? "thermal58-receipt" : "thermal80-receipt")!;
}

function jobHtml(printer: StoredPrinter, job: PrintJob, branding: PrintBranding): { html: string; paper?: PaperKey; kickDrawer: boolean } {
  const width = resolvedPaperWidthMm(printer.connection);
  switch (job.type) {
    case "document":
      return { html: job.html, paper: job.paper, kickDrawer: false };
    case "receipt": {
      const template = templateFor(printer, "receipt");
      return {
        html: renderPrintTemplate(template, receiptToPrintDocument(job.receipt, branding), {
          paperOverride: paperOfPrinter(printer.connection),
        }),
        paper: template.paper,
        kickDrawer: job.kickDrawer === true,
      };
    }
    case "kitchen-ticket": {
      const template = templateFor(printer, "kitchen");
      return {
        html: renderPrintTemplate(template, kitchenToPrintDocument(job.ticket), {
          paperOverride: width === 58 ? "thermal58" : "thermal80",
        }),
        paper: template.paper,
        kickDrawer: false,
      };
    }
    case "label":
      return { html: renderLabelHtml(job.label), kickDrawer: false };
    case "test": {
      if (job.kind === "document" || isSheetPaper(paperOfPrinter(printer.connection))) {
        return { html: TEST_HTML, paper: "a4", kickDrawer: false };
      }
      const sample = job.kind === "kitchen"
        ? renderPrintTemplate(templateFor(printer, "kitchen"), kitchenToPrintDocument(SAMPLE_TICKET))
        : renderPrintTemplate(templateFor(printer, "receipt"), receiptToPrintDocument(SAMPLE_RECEIPT, branding));
      return { html: sample, kickDrawer: false };
    }
    case "drawer-kick":
      return { html: "", kickDrawer: false };
  }
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
  return buildPrintJob(raster, { kickDrawer: opts.kickDrawer === true, cut: true });
}

/**
 * Render a job to its canonical ESC/POS byte stream. Pure pipeline:
 * template → HTML (with the Persian font embedded) → Chromium screenshot →
 * monochrome raster → GS v 0 commands, plus feed/cut and — for printers
 * configured with «بازکردن کشوی پول» — the drawer kick.
 */
export async function buildJobBytes(printer: StoredPrinter, job: PrintJob, branding: PrintBranding = {}): Promise<Buffer> {
  if (job.type === "drawer-kick") return buildDrawerKickJob();
  const rendered = jobHtml(printer, job, branding);
  if (rendered.paper && PAPERS[rendered.paper].kind === "sheet") {
    throw new Error("sheet_documents_print_as_pages");
  }
  return rasterJobBytes(printer, rendered.html, { kickDrawer: rendered.kickDrawer, paper: rendered.paper });
}

/** Page printers get a PNG the Windows driver accepts. Thermal printers get ESC/POS. */
export async function preparePrint(printer: StoredPrinter, job: PrintJob, branding: PrintBranding = {}): Promise<PreparedPrint> {
  if (job.type === "drawer-kick") return { delivery: "raw", bytes: buildDrawerKickJob() };
  const rendered = jobHtml(printer, job, branding);
  const sheet = rendered.paper != null && PAPERS[rendered.paper].kind === "sheet";
  if (sheet) {
    const png = await renderHtmlToPng(rendered.html, rasterWidthFor(printer, rendered.paper));
    return { delivery: "page", bytes: png };
  }
  return { delivery: "raw", bytes: await rasterJobBytes(printer, rendered.html, { kickDrawer: rendered.kickDrawer, paper: rendered.paper }) };
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
