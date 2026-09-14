import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import type { LabelData } from "@/lib/label-template";
import { isValidPrinterConnection, type PrinterConnection } from "@/lib/printer-connection";
import { isPaperKey } from "@/lib/print-template";
import type { ReceiptData } from "@/lib/receipt-template";
import { buildJobBytes, type RenderableJob } from "@/lib/system-print/service";

/**
 * Render a print job to raw ESC/POS bytes and hand them back — the server
 * half of the `webusb` transport, where the BROWSER is the delivery
 * middleman. A server installation cannot see the till's local printers at
 * all (the server is in a container or another building), but the browser
 * sitting at the counter can: WebUSB gives the page a direct pipe to a USB
 * receipt printer. The split follows what each side actually has — the
 * server has the Chromium raster pipeline that shapes Persian text, the
 * browser has the cable. No print dialog is involved anywhere.
 *
 * Same body shape as /api/print/job minus the sending; responds with the
 * bytes as application/octet-stream. Same role list as /api/print/job and
 * /api/printers — every role that can trigger a print.
 */
interface RenderBody {
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

  let body: RenderBody;
  try {
    body = (await request.json()) as RenderBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const connection = body.connection;
  if (!connection || !isValidPrinterConnection(connection)) {
    return NextResponse.json({ ok: false, error: "invalid_connection" }, { status: 400 });
  }

  let job: RenderableJob;
  switch (body.op) {
    case "document": {
      const html = typeof body.html === "string" ? body.html : "";
      if (!html) return NextResponse.json({ ok: false, error: "missing_html" }, { status: 400 });
      if (html.length > 8_000_000) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
      job = { op: "document", html, paper: isPaperKey(body.paper) ? body.paper : undefined };
      break;
    }
    case "receipt":
      if (!body.receipt) return NextResponse.json({ ok: false, error: "missing_receipt" }, { status: 400 });
      job = { op: "receipt", receipt: body.receipt };
      break;
    case "kitchen-ticket":
      if (!body.ticket) return NextResponse.json({ ok: false, error: "missing_ticket" }, { status: 400 });
      job = { op: "kitchen-ticket", ticket: body.ticket };
      break;
    case "label":
      if (!body.label) return NextResponse.json({ ok: false, error: "missing_label" }, { status: 400 });
      job = { op: "label", label: body.label };
      break;
    case "test":
      job = { op: "test", kind: body.kind === "kitchen" ? "kitchen" : "receipt" };
      break;
    case "drawer-kick":
      job = { op: "drawer-kick" };
      break;
    default:
      return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
  }

  try {
    const bytes = await buildJobBytes(connection, job);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message || "render_failed" }, { status: 502 });
  }
});
