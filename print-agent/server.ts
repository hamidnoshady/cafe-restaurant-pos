/**
 * Print agent (Phase 5, extended) — a small standalone Node service meant to
 * run on the till PC, next to the actual printer/cash drawer hardware. It has
 * no database access and knows nothing about businesses/locations/auth; the
 * dashboard (running in the same PC's browser) tells it which printer to use
 * by passing that printer's `connection` (from the `printers` table) with
 * every request. Run with `npm run print-agent`.
 *
 * It now speaks four transports rather than one (see
 * src/lib/printer-connection.ts): a raw TCP socket to a LAN/Wi-Fi printer, an
 * installed Windows/CUPS queue by name, a raw USB/serial device path, and —
 * handled entirely in the browser, never here — the browser's own print
 * dialog. And it can *find* printers rather than only use ones somebody typed
 * an IP for: /printers/system lists the OS's installed queues, /printers/scan
 * sweeps the LAN for port 9100.
 *
 * Endpoints (all POST except the GETs), loopback-only:
 *   GET  /health
 *   GET  /printers/system              → the OS's installed print queues
 *   POST /printers/scan                { subnets?, ports?, timeoutMs? }
 *   POST /printers/probe               { connection } — is it reachable?
 *   POST /print/document               { connection, html, paper } ← the template renderer's output
 *   POST /print/receipt                { connection, receipt: ReceiptData }
 *   POST /print/kitchen-ticket         { connection, ticket: KitchenTicketData }
 *   POST /print/label                  { connection, label: LabelData }
 *   POST /print/test                   { connection, kind }
 *   POST /drawer/kick                  { connection }
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { Socket } from "net";
import {
  buildDrawerKickJob,
  buildPrintJob,
  packMonochromeRaster,
} from "../src/lib/escpos";
import { renderKitchenTicketHtml, type KitchenTicketData } from "../src/lib/kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../src/lib/label-template";
import {
  isValidPrinterConnection,
  resolvedDriverMode,
  resolvedPaperWidthMm,
  resolvedPort,
  resolvedTransport,
  type PrinterConnection,
} from "../src/lib/printer-connection";
import { PAPERS, isPaperKey, type PaperKey } from "../src/lib/print-template";
import { PAPER_WIDTH_PRESETS, renderReceiptHtml, type ReceiptData } from "../src/lib/receipt-template";
import { listSystemPrinters, scanLanPrinters } from "./discovery";
import { decodePngToGrayscale } from "./png";
import { renderHtmlToPdf, renderHtmlToPng } from "./render";
import { sendRawToDevice, sendDocumentToSystemPrinter, sendRawToSystemPrinter } from "./spooler";
import { sendToPrinter } from "./transport";

const PORT = Number(process.env.PRINT_AGENT_PORT) || 9123;

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

/** ESC/POS raster: screenshot the HTML, pack it, and hand it to the transport. */
async function printRaster(
  connection: PrinterConnection,
  html: string,
  opts: { kickDrawer?: boolean; paper?: PaperKey } = {},
): Promise<void> {
  const png = await renderHtmlToPng(html, rasterWidthFor(connection, opts.paper));
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  const job = buildPrintJob(raster, { kickDrawer: opts.kickDrawer ?? connection.openDrawer, cut: true });
  await sendBytes(connection, job);
}

/** The one place raw ESC/POS bytes leave the agent, whatever the transport. */
async function sendBytes(connection: PrinterConnection, job: Buffer): Promise<void> {
  switch (resolvedTransport(connection)) {
    case "network":
      return sendToPrinter(connection.ip!, resolvedPort(connection), job);
    case "system":
      return sendRawToSystemPrinter(connection.systemName!, job);
    case "usb":
      return sendRawToDevice(connection.devicePath!, job);
    case "browser":
      throw new Error("browser_transport_is_client_side");
  }
}

/**
 * Print a document the template renderer produced. A thermal roll takes the
 * raster path; a sheet on an installed queue is rendered to PDF and spooled,
 * because a laser driver wants a page rather than a bitmap.
 */
async function printDocument(
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

/** Is this printer answering right now? A TCP handshake, or the OS's queue list. */
async function probeConnection(connection: PrinterConnection): Promise<{ reachable: boolean; detail?: string }> {
  const transport = resolvedTransport(connection);
  if (transport === "browser") return { reachable: true, detail: "browser" };
  if (transport === "usb") return { reachable: true, detail: "unverifiable" };
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

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) req.destroy(); // 8MB cap — a logo data URL rides along with the HTML
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    // Loopback-only server; CORS is wide open since the only thing that can
    // reach it at all is a process on the same machine.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(json);
}

/** Endpoints that don't target a printer, so they carry no `connection`. */
const CONNECTIONLESS = new Set(["/health", "/printers/system", "/printers/scan"]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, platform: process.platform, version: 2 });
  }
  if (req.method === "GET" && req.url === "/printers/system") {
    return send(res, 200, { ok: true, printers: await listSystemPrinters() });
  }

  if (req.method !== "POST") return send(res, 404, { ok: false, error: "not_found" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return send(res, 400, { ok: false, error: "bad_request" });
  }

  const connection = body.connection as PrinterConnection | undefined;
  if (!CONNECTIONLESS.has(req.url ?? "") && (!connection || !isValidPrinterConnection(connection))) {
    return send(res, 400, { ok: false, error: "invalid_connection" });
  }

  try {
    if (req.url === "/printers/scan") {
      const printers = await scanLanPrinters({
        subnets: Array.isArray(body.subnets) ? (body.subnets as string[]) : undefined,
        ports: Array.isArray(body.ports) ? (body.ports as number[]) : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return send(res, 200, { ok: true, printers });
    }

    if (req.url === "/printers/probe") {
      return send(res, 200, { ok: true, ...(await probeConnection(connection!)) });
    }

    if (req.url === "/print/document") {
      const html = typeof body.html === "string" ? body.html : "";
      if (!html) return send(res, 400, { ok: false, error: "missing_html" });
      const paper = isPaperKey(body.paper) ? body.paper : undefined;
      await printDocument(connection!, html, paper);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/receipt") {
      const receipt = body.receipt as ReceiptData;
      const html = renderReceiptHtml(receipt, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printRaster(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/kitchen-ticket") {
      const ticket = body.ticket as KitchenTicketData;
      const html = renderKitchenTicketHtml(ticket, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printRaster(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/label") {
      const label = body.label as LabelData;
      await printRaster(connection!, renderLabelHtml(label));
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/test") {
      const kind = body.kind === "kitchen" ? "kitchen" : "receipt";
      const html =
        kind === "kitchen"
          ? renderKitchenTicketHtml(SAMPLE_TICKET, { paperWidthMm: resolvedPaperWidthMm(connection!) })
          : renderReceiptHtml(SAMPLE_RECEIPT, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printRaster(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/drawer/kick") {
      await sendBytes(connection!, buildDrawerKickJob());
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    return send(res, 502, { ok: false, error: (err as Error).message || "printer_unreachable" });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => send(res, 500, { ok: false, error: "internal_error" }));
});

// Loopback-only: this agent is never meant to be reachable over the LAN.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`> Print agent ready on http://127.0.0.1:${PORT}`);
});
