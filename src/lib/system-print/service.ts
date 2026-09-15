/**
 * The one implementation of "put this document on that printer" — shared by
 * the standalone local print agent (print-agent/server.ts, running on the
 * till PC next to the hardware) and the app server's own /api/print/* routes
 * (running wherever the app runs, which in every local deployment shape —
 * Electron shell, Docker on the till laptop, an on-prem LAN server — is a
 * machine that can also see the printers).
 *
 * Having both callers share this module is what makes the fallback honest:
 * whichever process ends up printing, it is the same raster, the same
 * spooler call, the same probe. Server-only (child_process/net/playwright);
 * never import from client components.
 */
import { Socket } from "net";
import {
  buildDrawerKickJob,
  buildPrintJob,
  packMonochromeRaster,
} from "../escpos";
import { renderKitchenTicketHtml, type KitchenTicketData } from "../kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../label-template";
import {
  resolvedDriverMode,
  resolvedPaperWidthMm,
  resolvedPort,
  resolvedTransport,
  type PrinterConnection,
} from "../printer-connection";
import { PAPERS, type PaperKey } from "../print-template";
import { PAPER_WIDTH_PRESETS, renderReceiptHtml, type ReceiptData } from "../receipt-template";
import { listSystemPrinters, scanLanPrinters } from "./discovery";
import { decodePngToGrayscale } from "./png";
import { renderHtmlToPdf, renderHtmlToPng } from "./render";
import { sendRawToDevice, sendDocumentToSystemPrinter, sendRawToSystemPrinter } from "./spooler";
import { sendToPrinter } from "./transport";

export { listSystemPrinters, scanLanPrinters };

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

/** Raster width for a paper: the template's own preset, or the ESC/POS default. */
function rasterWidthFor(connection: PrinterConnection, paper?: PaperKey): number {
  if (paper && PAPERS[paper]?.rasterPx) return PAPERS[paper].rasterPx!;
  return PAPER_WIDTH_PRESETS[resolvedPaperWidthMm(connection)];
}

/** ESC/POS raster job bytes: screenshot the HTML and pack it — no sending. */
async function rasterJobBytes(
  connection: PrinterConnection,
  html: string,
  opts: { kickDrawer?: boolean; paper?: PaperKey } = {},
): Promise<Buffer> {
  const png = await renderHtmlToPng(html, rasterWidthFor(connection, opts.paper));
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  return buildPrintJob(raster, { kickDrawer: opts.kickDrawer ?? connection.openDrawer, cut: true });
}

/** ESC/POS raster: render the job and hand it to the transport. */
async function printRaster(
  connection: PrinterConnection,
  html: string,
  opts: { kickDrawer?: boolean; paper?: PaperKey } = {},
): Promise<void> {
  await sendBytes(connection, await rasterJobBytes(connection, html, opts));
}

/** The one place raw ESC/POS bytes leave the process, whatever the transport. */
async function sendBytes(connection: PrinterConnection, job: Buffer): Promise<void> {
  switch (resolvedTransport(connection)) {
    case "network":
      return sendToPrinter(connection.ip!, resolvedPort(connection), job);
    case "system":
      return sendRawToSystemPrinter(connection.systemName!, job);
    case "usb":
      return sendRawToDevice(connection.devicePath!, job);
    case "webusb":
      // The webusb transport delivers through the *browser* (WebUSB): the
      // server only renders the job bytes (see buildJobBytes below) and the
      // client pushes them to the device. Reaching this line means a caller
      // routed a webusb printer at a server-side sender by mistake.
      throw new Error("webusb_transport_is_client_side");
    case "browser":
      throw new Error("browser_transport_is_client_side");
  }
}

/**
 * Print a document the template renderer produced. A thermal roll takes the
 * raster path; a sheet on an installed queue is rendered to PDF and spooled,
 * because a laser driver wants a page rather than a bitmap.
 */
export async function printDocumentJob(
  connection: PrinterConnection,
  html: string,
  paper: PaperKey | undefined,
): Promise<void> {
  const spec = paper ? PAPERS[paper] : null;
  const transport = resolvedTransport(connection);
  const wantsDocument = spec ? spec.kind === "sheet" : resolvedDriverMode(connection) === "document";

  if (wantsDocument) {
    if (transport !== "system") throw new Error("sheet_printing_needs_a_system_printer");
    const pdf = await renderHtmlToPdf(html);
    return sendDocumentToSystemPrinter(connection.systemName!, pdf, { copies: connection.copies });
  }
  return printRaster(connection, html, { paper });
}

export async function printReceiptJob(connection: PrinterConnection, receipt: ReceiptData): Promise<void> {
  const html = renderReceiptHtml(receipt, { paperWidthMm: resolvedPaperWidthMm(connection) });
  await printRaster(connection, html);
}

export async function printKitchenTicketJob(connection: PrinterConnection, ticket: KitchenTicketData): Promise<void> {
  const html = renderKitchenTicketHtml(ticket, { paperWidthMm: resolvedPaperWidthMm(connection) });
  await printRaster(connection, html);
}

export async function printLabelJob(connection: PrinterConnection, label: LabelData): Promise<void> {
  await printRaster(connection, renderLabelHtml(label));
}

export async function printTestJob(connection: PrinterConnection, kind: "receipt" | "kitchen"): Promise<void> {
  const html =
    kind === "kitchen"
      ? renderKitchenTicketHtml(SAMPLE_TICKET, { paperWidthMm: resolvedPaperWidthMm(connection) })
      : renderReceiptHtml(SAMPLE_RECEIPT, { paperWidthMm: resolvedPaperWidthMm(connection) });
  await printRaster(connection, html);
}

export async function kickDrawerJob(connection: PrinterConnection): Promise<void> {
  await sendBytes(connection, buildDrawerKickJob());
}

/* ─────────────── rendering without sending (the WebUSB path) ─────────────── */

export type RenderableJob =
  | { op: "document"; html: string; paper?: PaperKey }
  | { op: "receipt"; receipt: ReceiptData }
  | { op: "kitchen-ticket"; ticket: KitchenTicketData }
  | { op: "label"; label: LabelData }
  | { op: "test"; kind: "receipt" | "kitchen" }
  | { op: "drawer-kick" };

/**
 * Render a print job to its raw ESC/POS byte stream WITHOUT sending it —
 * the server half of browser-mediated delivery through either WebUSB or the
 * lightweight Windows connector. The server owns the Chromium raster pipeline
 * (Persian shaping needs a real browser engine — see ../escpos.ts), while the
 * till PC owns the USB cable or Windows spooler queue. Only raster output: a
 * sheet PDF has no meaning in this raw-byte protocol.
 */
export async function buildJobBytes(connection: PrinterConnection, job: RenderableJob): Promise<Buffer> {
  switch (job.op) {
    case "document": {
      const spec = job.paper ? PAPERS[job.paper] : null;
      if (spec && spec.kind === "sheet") throw new Error("sheet_printing_needs_a_system_printer");
      return rasterJobBytes(connection, job.html, { paper: job.paper });
    }
    case "receipt":
      return rasterJobBytes(connection, renderReceiptHtml(job.receipt, { paperWidthMm: resolvedPaperWidthMm(connection) }));
    case "kitchen-ticket":
      return rasterJobBytes(
        connection,
        renderKitchenTicketHtml(job.ticket, { paperWidthMm: resolvedPaperWidthMm(connection) }),
      );
    case "label":
      return rasterJobBytes(connection, renderLabelHtml(job.label));
    case "test":
      return rasterJobBytes(
        connection,
        job.kind === "kitchen"
          ? renderKitchenTicketHtml(SAMPLE_TICKET, { paperWidthMm: resolvedPaperWidthMm(connection) })
          : renderReceiptHtml(SAMPLE_RECEIPT, { paperWidthMm: resolvedPaperWidthMm(connection) }),
      );
    case "drawer-kick":
      return buildDrawerKickJob();
  }
}

/** Is this printer answering right now? A TCP handshake, or the OS's queue list. */
export async function probeConnection(connection: PrinterConnection): Promise<{ reachable: boolean; detail?: string }> {
  const transport = resolvedTransport(connection);
  if (transport === "browser") return { reachable: true, detail: "browser" };
  if (transport === "usb") return { reachable: true, detail: "unverifiable" };
  // Only the browser holding the WebUSB permission can see the device; the
  // client checks it locally (print-agent-client.ts) before ever asking here.
  if (transport === "webusb") return { reachable: true, detail: "unverifiable_from_server" };
  if (transport === "system") {
    const printers = await listSystemPrinters();
    const match = printers.find((p) => p.name === connection.systemName);
    return { reachable: Boolean(match), detail: match?.status ?? undefined };
  }
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (reachable: boolean, detail?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, detail });
    };
    socket.setTimeout(3000);
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (err) => finish(false, err.message));
    socket.connect(resolvedPort(connection), connection.ip!, () => finish(true));
  });
}
