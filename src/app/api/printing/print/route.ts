import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { buildJobBytes, loadPrinterForJob, printerRefusal, type PrintJob } from "@/lib/printing/render-service";
import { printerTargetOf } from "@/lib/printing/types";
import { isPaperKey, PAPERS } from "@/lib/print-template";

/**
 * The one hardware print endpoint: render a saved printer's job to canonical
 * ESC/POS bytes on the authenticated app server and hand them back for local
 * delivery. The request carries ONLY a printer ID — the printer, its hardware
 * target and its settings are loaded from the database for the caller's
 * active location, so a hand-edited request can neither print through
 * another branch's printer nor aim the server at an arbitrary IP, queue or
 * port. The server never touches restaurant hardware; the browser forwards
 * these bytes to the local Cafe POS connector.
 *
 * Every role that can trigger a print needs access, the same reasoning as
 * GET /api/printers (which tells those callers which printer is which).
 */
export const runtime = "nodejs";

interface PrintRequestBody {
  printerId?: string;
  job?: {
    type?: string;
    receipt?: unknown;
    ticket?: unknown;
    label?: unknown;
    kind?: unknown;
    html?: unknown;
    paper?: unknown;
  };
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  let body: PrintRequestBody;
  try {
    body = (await request.json()) as PrintRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (typeof body.printerId !== "string" || !body.printerId) {
    return NextResponse.json({ ok: false, error: "printer_not_found" }, { status: 400 });
  }
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false, error: "printer_not_found" }, { status: 404 });

  const printer = await loadPrinterForJob(location.id, body.printerId);
  if (!printer) return NextResponse.json({ ok: false, error: "printer_not_found" }, { status: 404 });

  const refusal = printerRefusal(printer);
  if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 409 });

  const target = printerTargetOf(printer.connection);
  if (!target) return NextResponse.json({ ok: false, error: "reconnect_required" }, { status: 409 });

  const job = parseJob(body.job);
  if (!job) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    const bytes = await buildJobBytes(printer, job);
    return NextResponse.json({
      ok: true,
      target,
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
  } catch (err) {
    console.error("print render failed", err);
    return NextResponse.json({ ok: false, error: "render_failed" }, { status: 502 });
  }
});

function parseJob(raw: PrintRequestBody["job"]): PrintJob | null {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "receipt":
      return raw.receipt ? { type: "receipt", receipt: raw.receipt as never } : null;
    case "kitchen-ticket":
      return raw.ticket ? { type: "kitchen-ticket", ticket: raw.ticket as never } : null;
    case "label":
      return raw.label ? { type: "label", label: raw.label as never } : null;
    case "test":
      return { type: "test", kind: raw.kind === "kitchen" ? "kitchen" : "receipt" };
    case "drawer-kick":
      return { type: "drawer-kick" };
    case "document": {
      const html = typeof raw.html === "string" ? raw.html : "";
      if (!html) return null;
      if (html.length > 8_000_000) return null;
      const paper = isPaperKey(raw.paper) ? raw.paper : null;
      if (!paper || (PAPERS[paper].kind !== "thermal" && PAPERS[paper].kind !== "label")) return null;
      return { type: "document", html, paper };
    }
    default:
      return null;
  }
}
