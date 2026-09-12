/**
 * Browser-side client for the local print agent (print-agent/server.ts),
 * which listens on loopback on the till PC. The dashboard (running in the
 * cashier/waiter's browser, on the same machine as the agent) talks to it
 * directly rather than through the Next.js server — see the Phase 5 doc for
 * why (the agent needs to run wherever the physical printer/cash drawer is
 * actually wired up, which may not be where the app server runs).
 *
 * It also owns the *no-agent* path: `printViaBrowser` puts a rendered document
 * into a hidden iframe and calls the browser's own print dialog. That is what
 * makes the printing section usable on a tablet, on a phone, and on day one
 * before anybody has paired hardware — and it is the same HTML string the
 * agent would have rastered, so what a shop designs is what it gets either
 * way.
 */
import type { PrinterConnection } from "./printer-connection";
import { resolvedTransport } from "./printer-connection";
import type { KitchenTicketData } from "./kitchen-ticket-template";
import type { LabelData } from "./label-template";
import type { PaperKey } from "./print-template";
import type { ReceiptData } from "./receipt-template";

function agentBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_AGENT_URL || "http://127.0.0.1:9123";
}

export interface AgentResult<T = { ok: boolean }> {
  ok: boolean;
  unreachable?: boolean;
  error?: string;
  data?: T;
}

async function callAgent<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; method?: "GET" | "POST" } = {},
): Promise<AgentResult<T>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    const method = opts.method ?? "POST";
    const res = await fetch(`${agentBaseUrl()}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    let data: unknown = {};
    try {
      data = await res.json();
    } catch {
      // no body
    }
    if (!res.ok) return { ok: false, error: (data as { error?: string })?.error ?? "agent_error", data: data as T };
    return { ok: true, data: data as T };
  } catch {
    // agent not running, or unreachable — printing is best-effort, never blocks the flow that triggered it
    return { ok: false, unreachable: true, error: "agent_unreachable" };
  }
}

/* ─────────────────────── agent status & discovery ─────────────────────── */

export interface AgentHealth {
  ok: boolean;
  platform?: string;
  version?: number;
}

export function checkAgent(): Promise<AgentResult<AgentHealth>> {
  return callAgent<AgentHealth>("/health", {}, { method: "GET", timeoutMs: 2500 });
}

export interface SystemPrinter {
  name: string;
  driver?: string | null;
  port?: string | null;
  isDefault: boolean;
  status?: string | null;
  likelyThermal: boolean;
}

/** The Windows/CUPS print queues already installed on the till PC. */
export function listSystemPrinters(): Promise<AgentResult<{ printers: SystemPrinter[] }>> {
  return callAgent<{ printers: SystemPrinter[] }>("/printers/system", {}, { method: "GET", timeoutMs: 20_000 });
}

export interface LanPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/** Sweep the local network for ESC/POS printers listening on the raw-print port. */
export function scanLanPrinters(body: { subnets?: string[]; ports?: number[] } = {}) {
  return callAgent<{ printers: LanPrinter[] }>("/printers/scan", body, { timeoutMs: 90_000 });
}

export function probePrinter(connection: PrinterConnection) {
  return callAgent<{ reachable: boolean; detail?: string }>("/printers/probe", { connection }, { timeoutMs: 10_000 });
}

/* ───────────────────────────── printing ──────────────────────────────── */

/**
 * Print a rendered document (the output of `renderPrintTemplate`). Routes
 * itself: a `browser` printer — or no printer at all — goes to the browser's
 * print dialog, everything else to the agent.
 */
export async function printDocument(
  connection: PrinterConnection | null,
  html: string,
  paper: PaperKey,
): Promise<AgentResult> {
  if (!connection || resolvedTransport(connection) === "browser") {
    return printViaBrowser(html);
  }
  return callAgent("/print/document", { connection, html, paper }, { timeoutMs: 30_000 });
}

/**
 * Open the browser's print dialog on `html`, using a hidden same-document
 * iframe rather than `window.open`: a popup is blocked by default on most
 * setups and steals focus from the POS, while an iframe prints and disappears.
 */
export function printViaBrowser(html: string): Promise<AgentResult> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve({ ok: false, error: "not_in_browser" });
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.inset = "auto auto 0 0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.opacity = "0";

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      // Give the print dialog a moment to take its snapshot before the
      // document backing it goes away.
      setTimeout(() => frame.remove(), 1000);
      resolve({ ok: true });
    };

    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) {
          frame.remove();
          resolve({ ok: false, error: "print_frame_failed" });
          return;
        }
        win.focus();
        win.onafterprint = cleanup;
        win.print();
        // Safari/iOS never fire onafterprint; fall back to a timer.
        setTimeout(cleanup, 4000);
      } catch {
        frame.remove();
        resolve({ ok: false, error: "print_frame_failed" });
      }
    };

    document.body.appendChild(frame);
    frame.srcdoc = html;
  });
}

export function printReceipt(connection: PrinterConnection, receipt: ReceiptData) {
  return callAgent("/print/receipt", { connection, receipt });
}

export function printKitchenTicket(connection: PrinterConnection, ticket: KitchenTicketData) {
  return callAgent("/print/kitchen-ticket", { connection, ticket });
}

export function printLabel(connection: PrinterConnection, label: LabelData) {
  return callAgent("/print/label", { connection, label });
}

export function testPrint(connection: PrinterConnection, kind: "receipt" | "kitchen") {
  return callAgent("/print/test", { connection, kind });
}

export function kickDrawer(connection: PrinterConnection) {
  return callAgent("/drawer/kick", { connection });
}
