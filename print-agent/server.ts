/**
 * Print agent (Phase 5, extended) — a small standalone Node service meant to
 * run on the till PC, next to the actual printer/cash drawer hardware. It has
 * no database access and knows nothing about businesses/locations/auth; the
 * dashboard (running in the same PC's browser) tells it which printer to use
 * by passing that printer's `connection` (from the `printers` table) with
 * every request. Run with `npm run print-agent`.
 *
 * All of the actual printing machinery lives in src/lib/system-print/ and is
 * shared with the app server's own /api/print/* routes — when the app runs on
 * the same machine as the printers (Electron shell, Docker on the till
 * laptop, an on-prem LAN server), the browser can print through the app
 * server directly and this agent is optional. The agent remains the answer
 * when the app server runs somewhere the printers are not (a cloud tenant).
 *
 * It speaks four transports (see src/lib/printer-connection.ts): a raw TCP
 * socket to a LAN/Wi-Fi printer, an installed Windows/CUPS queue by name, a
 * raw USB/serial device path, and — handled entirely in the browser, never
 * here — the browser's own print dialog. And it can *find* printers rather
 * than only use ones somebody typed an IP for: /printers/system lists the
 * OS's installed queues, /printers/scan sweeps the LAN for port 9100.
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
import type { KitchenTicketData } from "../src/lib/kitchen-ticket-template";
import type { LabelData } from "../src/lib/label-template";
import { isValidPrinterConnection, type PrinterConnection } from "../src/lib/printer-connection";
import { isPaperKey } from "../src/lib/print-template";
import type { ReceiptData } from "../src/lib/receipt-template";
import {
  kickDrawerJob,
  listSystemPrinters,
  printDocumentJob,
  printKitchenTicketJob,
  printLabelJob,
  printReceiptJob,
  printTestJob,
  probeConnection,
  scanLanPrinters,
} from "../src/lib/system-print/service";

const PORT = Number(process.env.PRINT_AGENT_PORT) || 9123;

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
      await printDocumentJob(connection!, html, paper);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/receipt") {
      await printReceiptJob(connection!, body.receipt as ReceiptData);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/kitchen-ticket") {
      await printKitchenTicketJob(connection!, body.ticket as KitchenTicketData);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/label") {
      await printLabelJob(connection!, body.label as LabelData);
      return send(res, 200, { ok: true });
    }

    if (req.url === "/print/test") {
      await printTestJob(connection!, body.kind === "kitchen" ? "kitchen" : "receipt");
      return send(res, 200, { ok: true });
    }

    if (req.url === "/drawer/kick") {
      await kickDrawerJob(connection!);
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
