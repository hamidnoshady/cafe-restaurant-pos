/**
 * Browser-side client for the local print agent (print-agent/server.ts),
 * which listens on loopback on the till PC. The dashboard (running in the
 * cashier/waiter's browser, on the same machine as the agent) talks to it
 * directly rather than through the Next.js server — see the Phase 5 doc for
 * why (the agent needs to run wherever the physical printer/cash drawer is
 * actually wired up, which may not be where the app server runs).
 */
import type { PrinterConnection } from "./printer-connection";
import type { KitchenTicketData } from "./kitchen-ticket-template";
import type { ReceiptData } from "./receipt-template";

function agentBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_AGENT_URL || "http://127.0.0.1:9123";
}

async function callAgent<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; unreachable?: boolean; error?: string; data?: T }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${agentBaseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

export function printReceipt(connection: PrinterConnection, receipt: ReceiptData) {
  return callAgent("/print/receipt", { connection, receipt });
}

export function printKitchenTicket(connection: PrinterConnection, ticket: KitchenTicketData) {
  return callAgent("/print/kitchen-ticket", { connection, ticket });
}

export function testPrint(connection: PrinterConnection, kind: "receipt" | "kitchen") {
  return callAgent("/print/test", { connection, kind });
}

export function kickDrawer(connection: PrinterConnection) {
  return callAgent("/drawer/kick", { connection });
}
