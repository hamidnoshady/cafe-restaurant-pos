import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import type { LabelData } from "@/lib/label-template";
import { isValidPrinterConnection, type PrinterConnection } from "@/lib/printer-connection";
import { isPaperKey } from "@/lib/print-template";
import type { ReceiptData } from "@/lib/receipt-template";
import {
  kickDrawerJob,
  printDocumentJob,
  printKitchenTicketJob,
  printLabelJob,
  printReceiptJob,
  printTestJob,
} from "@/lib/system-print/service";

/**
 * Server-side printing — the app server's twin of the local print agent's
 * /print/* and /drawer/kick endpoints, collapsed into one route with an `op`
 * discriminator. The browser's print client (print-agent-client.ts) tries the
 * loopback agent first and falls back to this; on the deployment shapes where
 * the app server IS the till machine (Electron shell, Docker on the till
 * laptop, an on-prem LAN server), that fallback is what lets a shop print to
 * its installed Windows printers with nothing extra running.
 *
 * Every role that can trigger a print needs access — the same reasoning as
 * GET /api/printers, which is what hands these callers the connection they
 * pass here. The connection is not re-checked against the printers table on
 * purpose: it matches the agent's trust model (the caller already holds the
 * connection object), and a forged connection can only reach a printer.
 */
interface PrintJobBody {
  op?: "document" | "receipt" | "kitchen-ticket" | "label" | "test" | "drawer-kick";
  connection?: PrinterConnection;
  html?: string;
  paper?: string;
  receipt?: ReceiptData;
  ticket?: KitchenTicketData;
  label?: LabelData;
  kind?: "receipt" | "kitchen";
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  let body: PrintJobBody;
  try {
    body = (await request.json()) as PrintJobBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const connection = body.connection;
  if (!connection || !isValidPrinterConnection(connection)) {
    return NextResponse.json({ ok: false, error: "invalid_connection" }, { status: 400 });
  }

  try {
    switch (body.op) {
      case "document": {
        const html = typeof body.html === "string" ? body.html : "";
        if (!html) return NextResponse.json({ ok: false, error: "missing_html" }, { status: 400 });
        if (html.length > 8_000_000) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
        await printDocumentJob(connection, html, isPaperKey(body.paper) ? body.paper : undefined);
        return NextResponse.json({ ok: true });
      }
      case "receipt": {
        if (!body.receipt) return NextResponse.json({ ok: false, error: "missing_receipt" }, { status: 400 });
        await printReceiptJob(connection, body.receipt);
        return NextResponse.json({ ok: true });
      }
      case "kitchen-ticket": {
        if (!body.ticket) return NextResponse.json({ ok: false, error: "missing_ticket" }, { status: 400 });
        await printKitchenTicketJob(connection, body.ticket);
        return NextResponse.json({ ok: true });
      }
      case "label": {
        if (!body.label) return NextResponse.json({ ok: false, error: "missing_label" }, { status: 400 });
        await printLabelJob(connection, body.label);
        return NextResponse.json({ ok: true });
      }
      case "test": {
        await printTestJob(connection, body.kind === "kitchen" ? "kitchen" : "receipt");
        return NextResponse.json({ ok: true });
      }
      case "drawer-kick": {
        await kickDrawerJob(connection);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message || "printer_unreachable" },
      { status: 502 },
    );
  }
});
