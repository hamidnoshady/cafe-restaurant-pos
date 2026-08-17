/**
 * Print agent (Phase 5) — a small standalone Node service meant to run on
 * the till PC, next to the actual printer/cash drawer hardware. It has no
 * database access and knows nothing about businesses/locations/auth; the
 * dashboard (running in the same PC's browser) tells it which printer to
 * use by passing that printer's `connection` (ip/port, from the `printers`
 * table) with every request. Run with `npm run print-agent`.
 *
 * Endpoints (all POST except /health), loopback-only:
 *   GET  /health
 *   POST /print/receipt        { connection, receipt: ReceiptData }
 *   POST /print/kitchen-ticket { connection, ticket: KitchenTicketData }
 *   POST /print/label          { connection, label: LabelData }
 *   POST /print/test           { connection, kind: "receipt" | "kitchen" }
 *   POST /drawer/kick          { connection }
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  buildDrawerKickJob,
  buildPrintJob,
  packMonochromeRaster,
} from "../src/lib/escpos";
import { renderKitchenTicketHtml, type KitchenTicketData } from "../src/lib/kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../src/lib/label-template";
import {
  isValidPrinterConnection,
  resolvedPaperWidthMm,
  resolvedPort,
  type PrinterConnection,
} from "../src/lib/printer-connection";
import { PAPER_WIDTH_PRESETS, renderReceiptHtml, type ReceiptData } from "../src/lib/receipt-template";
import { decodePngToGrayscale } from "./png";
import { renderHtmlToPng } from "./render";
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

async function printHtml(connection: PrinterConnection, html: string, opts: { kickDrawer?: boolean } = {}): Promise<void> {
  const widthPx = PAPER_WIDTH_PRESETS[resolvedPaperWidthMm(connection)];
  const png = await renderHtmlToPng(html, widthPx);
  const gray = decodePngToGrayscale(png);
  const raster = packMonochromeRaster(gray.pixels, gray.width, gray.height);
  const job = buildPrintJob(raster, { kickDrawer: opts.kickDrawer, cut: true });
  await sendToPrinter(connection.ip!, resolvedPort(connection), job);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(); // 2MB payload cap
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });

  if (req.method !== "POST") return send(res, 404, { ok: false, error: "not_found" });

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return send(res, 400, { ok: false, error: "bad_request" });
  }

  const connection = body.connection as PrinterConnection | undefined;
  if (req.url !== "/health" && (!connection || !isValidPrinterConnection(connection))) {
    return send(res, 400, { ok: false, error: "invalid_connection" });
  }

  try {
    if (req.url === "/print/receipt") {
      const receipt = body.receipt as ReceiptData;
      const html = renderReceiptHtml(receipt, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printHtml(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/kitchen-ticket") {
      const ticket = body.ticket as KitchenTicketData;
      const html = renderKitchenTicketHtml(ticket, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printHtml(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/label") {
      const label = body.label as LabelData;
      await printHtml(connection!, renderLabelHtml(label));
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/test") {
      const kind = body.kind === "kitchen" ? "kitchen" : "receipt";
      const html =
        kind === "kitchen"
          ? renderKitchenTicketHtml(SAMPLE_TICKET, { paperWidthMm: resolvedPaperWidthMm(connection!) })
          : renderReceiptHtml(SAMPLE_RECEIPT, { paperWidthMm: resolvedPaperWidthMm(connection!) });
      await printHtml(connection!, html);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/drawer/kick") {
      await sendToPrinter(connection!.ip!, resolvedPort(connection!), buildDrawerKickJob());
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
