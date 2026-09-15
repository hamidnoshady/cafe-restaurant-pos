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
 * Every call tries the loopback agent first (it is closest to the hardware)
 * and falls back to the app server only when the agent is unreachable. The
 * dependency-free Windows connector can ask the server to render bytes while
 * retaining local delivery; once it claims a job, failures never fall through
 * to an unrelated cloud spooler.
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
import { probeWebUsbPrinter, sendBytesViaWebUsb } from "./webusb-print";

function agentBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_AGENT_URL || "http://127.0.0.1:9123";
}

// A cloud page used to hit a missing loopback service once for health, again
// for discovery, and again for every subsequent action. Apart from noisy
// ERR_CONNECTION_REFUSED entries, Chrome 142+ treats each attempt as Local
// Network Access and may repeatedly involve its permission UI. One failed
// attempt is enough for a short window; the explicit «check again» action
// clears this backoff immediately after the operator starts the agent.
const AGENT_RETRY_DELAY_MS = 15_000;
let agentRetryAfter = 0;
let agentHealthInFlight: Promise<AgentResult<AgentHealth>> | null = null;

/** Let an explicit user action retry the Windows helper immediately. */
export function allowPrintAgentRetry(): void {
  agentRetryAfter = 0;
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
  opts: { timeoutMs?: number; method?: "GET" | "POST"; force?: boolean } = {},
): Promise<AgentResult<T>> {
  if (!opts.force && Date.now() < agentRetryAfter) {
    return { ok: false, unreachable: true, error: "agent_unreachable" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const method = opts.method ?? "POST";
    // The literal 127.0.0.1 target lets current Chromium identify this as a
    // loopback request before mixed-content checks and show its one-time
    // «Apps on device / Local network access» permission when needed.
    const res = await fetch(`${agentBaseUrl()}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    agentRetryAfter = 0;
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
    // Agent not running, local-network permission denied, or unreachable —
    // printing is best-effort and never blocks the sale that triggered it.
    agentRetryAfter = Date.now() + AGENT_RETRY_DELAY_MS;
    return { ok: false, unreachable: true, error: "agent_unreachable" };
  } finally {
    clearTimeout(timeout);
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

interface RenderedJobResult extends AgentResult {
  bytes?: Uint8Array;
}

/** Render canonically on the authenticated app server while delivery stays on this PC. */
async function renderJobBytes(
  connection: PrinterConnection,
  job: Record<string, unknown>,
): Promise<RenderedJobResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const res = await fetch("/api/print/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...job, connection }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      let error = "render_failed";
      try {
        error = ((await res.json()) as { error?: string }).error ?? error;
      } catch {
        // non-JSON error body
      }
      return { ok: false, error, via: "server" };
    }
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()), via: "server" };
  } catch {
    return { ok: false, unreachable: true, error: "server_unreachable", via: "server" };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

/**
 * Send a rich job to either connector generation.
 *
 * The original Node agent renders and delivers the request directly. The
 * dependency-free one-click Windows connector deliberately answers
 * `render_required`; the browser then fetches the same canonical ESC/POS bytes
 * used by server printing and hands them back to `/print/raw` for native local
 * spooling. Once a connector has answered, an error is final — never retry the
 * local Windows queue against an unrelated cloud-server spooler.
 */
async function callLocalAgentPrint(
  path: string,
  connection: PrinterConnection,
  job: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<AgentResult> {
  const first = await callAgent(path, { ...job, connection }, { timeoutMs });
  if (first.ok || first.error !== "render_required") return first;

  const rendered = await renderJobBytes(connection, job);
  if (!rendered.ok || !rendered.bytes) {
    return { ...rendered, unreachable: undefined };
  }

  const delivered = await callAgent(
    "/print/raw",
    { connection, dataBase64: bytesToBase64(rendered.bytes) },
    { timeoutMs },
  );
  // The first request proved this PC owns the job. Do not let callWithFallback
  // send a second copy (or a local queue name) to the cloud if delivery fails.
  return delivered.ok ? delivered : { ...delivered, unreachable: undefined };
}

/**
 * The `webusb` transport — the browser as the delivery middleman for a
 * server installation that cannot see the till's local printers. The server
 * renders the ESC/POS bytes (/api/print/render — it owns the Chromium raster
 * pipeline that shapes Persian text), and THIS page pushes them to the USB
 * printer over WebUSB (webusb-print.ts). No print dialog opens anywhere.
 */
async function printViaWebUsb(
  connection: PrinterConnection,
  job: Record<string, unknown>,
): Promise<AgentResult> {
  const rendered = await renderJobBytes(connection, job);
  if (!rendered.ok || !rendered.bytes) return rendered;
  const sent = await sendBytesViaWebUsb(connection, rendered.bytes);
  if (!sent.ok) return { ok: false, error: sent.error, via: "server" };
  return { ok: true, via: "server" };
}

/* ─────────────────────── agent status & discovery ─────────────────────── */

export interface AgentHealth {
  ok: boolean;
  platform?: string;
  version?: number;
  /** "server" when the answer came from the app server's /api/print/health rather than the loopback agent. */
  source?: string;
}

export function checkAgent(opts: { forceAgentProbe?: boolean } = {}): Promise<AgentResult<AgentHealth>> {
  if (!opts.forceAgentProbe && agentHealthInFlight) return agentHealthInFlight;
  const probe = callWithFallback(
    () =>
      callAgent<AgentHealth>("/health", {}, {
        method: "GET",
        // A first cloud → loopback request may wait while Chrome/Edge shows
        // the one-time Local Network Access prompt. Give the operator time to
        // read and allow it; a genuinely closed port still refuses instantly.
        timeoutMs: 12_000,
        force: opts.forceAgentProbe === true,
      }),
    () => callServer<AgentHealth>("/api/print/health", null, { method: "GET", timeoutMs: 8000 }),
  );
  if (opts.forceAgentProbe) return probe;
  agentHealthInFlight = probe;
  void probe.finally(() => {
    if (agentHealthInFlight === probe) agentHealthInFlight = null;
  });
  return probe;
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

export async function probePrinter(connection: PrinterConnection): Promise<AgentResult<{ reachable: boolean; detail?: string }>> {
  // A WebUSB printer is only visible to the browser holding the pairing
  // permission — neither the agent nor the server can answer for it.
  if (resolvedTransport(connection) === "webusb") {
    const probed = await probeWebUsbPrinter(connection);
    return { ok: true, data: probed };
  }
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
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "document", html, paper });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/print/document", connection, { op: "document", html, paper }, 30_000),
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
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "receipt", receipt });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/print/receipt", connection, { op: "receipt", receipt }),
    () => callServer("/api/print/job", { op: "receipt", connection, receipt }),
  );
}

export function printKitchenTicket(connection: PrinterConnection, ticket: KitchenTicketData) {
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "kitchen-ticket", ticket });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/print/kitchen-ticket", connection, { op: "kitchen-ticket", ticket }),
    () => callServer("/api/print/job", { op: "kitchen-ticket", connection, ticket }),
  );
}

export function printLabel(connection: PrinterConnection, label: LabelData) {
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "label", label });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/print/label", connection, { op: "label", label }),
    () => callServer("/api/print/job", { op: "label", connection, label }),
  );
}

export function testPrint(connection: PrinterConnection, kind: "receipt" | "kitchen") {
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "test", kind });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/print/test", connection, { op: "test", kind }),
    () => callServer("/api/print/job", { op: "test", connection, kind }),
  );
}

export function kickDrawer(connection: PrinterConnection) {
  if (resolvedTransport(connection) === "webusb") {
    return printViaWebUsb(connection, { op: "drawer-kick" });
  }
  return callWithFallback(
    () => callLocalAgentPrint("/drawer/kick", connection, { op: "drawer-kick" }),
    () => callServer("/api/print/job", { op: "drawer-kick", connection }),
  );
}
