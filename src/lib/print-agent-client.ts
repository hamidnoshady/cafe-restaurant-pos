/**
 * Browser-side client for hardware printing. Two backends implement the same
 * operations (both on top of src/lib/system-print/service.ts):
 *
 *   1. The local print agent (print-agent/server.ts), listening on loopback
 *      on the till PC. It exists because the printer is wired to whatever
 *      machine is at the counter, which may not be where the app server runs
 *      (a cloud tenant with the till at the shop).
 *   2. The app server's own /api/print/* routes. On every local deployment
 *      shape — the Electron shell, Docker on the till laptop, an on-prem LAN
 *      server — the app server can see the same printers, so nobody has to
 *      install or start the separate agent for «چاپگرهای ویندوز» to appear.
 *
 * Every call tries the loopback agent first (it is closest to the hardware
 * and the historical behaviour), then falls back to the app server. Only when
 * BOTH are unreachable is the operation reported unreachable.
 *
 * This module also owns the *no-hardware* path: `printViaBrowser` puts a
 * rendered document into a hidden iframe and calls the browser's own print
 * dialog. That is what makes the printing section usable on a tablet, on a
 * phone, and on day one before anybody has paired hardware — and it is the
 * same HTML string the hardware path would have rastered, so what a shop
 * designs is what it gets either way.
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
  /** Which backend actually handled it: the loopback agent or the app server. */
  via?: "agent" | "server";
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
    if (!res.ok)
      return { ok: false, error: (data as { error?: string })?.error ?? "agent_error", data: data as T, via: "agent" };
    return { ok: true, data: data as T, via: "agent" };
  } catch {
    // agent not running, or unreachable — printing is best-effort, never blocks the flow that triggered it
    return { ok: false, unreachable: true, error: "agent_unreachable" };
  }
}

/** The same operation against the app server's /api/print/* twin routes (same-origin, session-cookie authenticated). */
async function callServer<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown> | null,
  opts: { timeoutMs?: number; method?: "GET" | "POST" } = {},
): Promise<AgentResult<T>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    const method = opts.method ?? "POST";
    const res = await fetch(path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    let data: unknown = {};
    try {
      data = await res.json();
    } catch {
      // no body
    }
    if (!res.ok)
      return { ok: false, error: (data as { error?: string })?.error ?? "server_error", data: data as T, via: "server" };
    return { ok: true, data: data as T, via: "server" };
  } catch {
    return { ok: false, unreachable: true, error: "server_unreachable" };
  }
}

/**
 * Agent first, app server second. A *reachable* backend's answer is final
 * even when it is an error (a real printer failure must surface, not be
 * retried against a machine that may be somewhere else entirely); only an
 * unreachable agent falls through.
 */
async function callWithFallback<T = { ok: boolean }>(
  agent: () => Promise<AgentResult<T>>,
  server: () => Promise<AgentResult<T>>,
): Promise<AgentResult<T>> {
  const first = await agent();
  if (first.ok || !first.unreachable) return first;
  return server();
}

/* ─────────────────────── agent status & discovery ─────────────────────── */

export interface AgentHealth {
  ok: boolean;
  platform?: string;
  version?: number;
  /** "server" when the answer came from the app server's /api/print/health rather than the loopback agent. */
  source?: string;
}

export function checkAgent(): Promise<AgentResult<AgentHealth>> {
  return callWithFallback(
    () => callAgent<AgentHealth>("/health", {}, { method: "GET", timeoutMs: 2500 }),
    () => callServer<AgentHealth>("/api/print/health", null, { method: "GET", timeoutMs: 8000 }),
  );
}

export interface SystemPrinter {
  name: string;
  driver?: string | null;
  port?: string | null;
  isDefault: boolean;
  status?: string | null;
  likelyThermal: boolean;
}

/** The Windows/CUPS print queues already installed on the till PC (agent) or the server machine (fallback). */
export function listSystemPrinters(): Promise<AgentResult<{ printers: SystemPrinter[] }>> {
  return callWithFallback(
    () => callAgent<{ printers: SystemPrinter[] }>("/printers/system", {}, { method: "GET", timeoutMs: 20_000 }),
    () => callServer<{ printers: SystemPrinter[] }>("/api/print/system-printers", null, { method: "GET", timeoutMs: 30_000 }),
  );
}

export interface LanPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/** Sweep the local network for ESC/POS printers listening on the raw-print port. */
export function scanLanPrinters(body: { subnets?: string[]; ports?: number[] } = {}) {
  return callWithFallback(
    () => callAgent<{ printers: LanPrinter[] }>("/printers/scan", body, { timeoutMs: 90_000 }),
    () => callServer<{ printers: LanPrinter[] }>("/api/print/scan", body, { timeoutMs: 120_000 }),
  );
}

export function probePrinter(connection: PrinterConnection) {
  return callWithFallback(
    () => callAgent<{ reachable: boolean; detail?: string }>("/printers/probe", { connection }, { timeoutMs: 10_000 }),
    () => callServer<{ reachable: boolean; detail?: string }>("/api/print/probe", { connection }, { timeoutMs: 15_000 }),
  );
}

/* ───────────────────────────── printing ──────────────────────────────── */

/**
 * Print a rendered document (the output of `renderPrintTemplate`). Routes
 * itself: a `browser` printer — or no printer at all — goes to the browser's
 * print dialog, everything else to the agent or the app server.
 */
export async function printDocument(
  connection: PrinterConnection | null,
  html: string,
  paper: PaperKey,
): Promise<AgentResult> {
  if (!connection || resolvedTransport(connection) === "browser") {
    return printViaBrowser(html);
  }
  return callWithFallback(
    () => callAgent("/print/document", { connection, html, paper }, { timeoutMs: 30_000 }),
    () => callServer("/api/print/job", { op: "document", connection, html, paper }, { timeoutMs: 45_000 }),
  );
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
  return callWithFallback(
    () => callAgent("/print/receipt", { connection, receipt }),
    () => callServer("/api/print/job", { op: "receipt", connection, receipt }),
  );
}

export function printKitchenTicket(connection: PrinterConnection, ticket: KitchenTicketData) {
  return callWithFallback(
    () => callAgent("/print/kitchen-ticket", { connection, ticket }),
    () => callServer("/api/print/job", { op: "kitchen-ticket", connection, ticket }),
  );
}

export function printLabel(connection: PrinterConnection, label: LabelData) {
  return callWithFallback(
    () => callAgent("/print/label", { connection, label }),
    () => callServer("/api/print/job", { op: "label", connection, label }),
  );
}

export function testPrint(connection: PrinterConnection, kind: "receipt" | "kitchen") {
  return callWithFallback(
    () => callAgent("/print/test", { connection, kind }),
    () => callServer("/api/print/job", { op: "test", connection, kind }),
  );
}

export function kickDrawer(connection: PrinterConnection) {
  return callWithFallback(
    () => callAgent("/drawer/kick", { connection }),
    () => callServer("/api/print/job", { op: "drawer-kick", connection }),
  );
}
