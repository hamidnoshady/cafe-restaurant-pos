import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { loadPrinterForJob, preparePrint, printerRefusal, resolvePrinterForLocation, type PrintJob } from "@/lib/printing/render-service";
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
  printRequestId?: string;
  documentType?: string;
  entityId?: string;
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
  const { session, error } = await requirePermission(PERMISSIONS.printingExecute);
  if (error) return error;

  let body: PrintRequestBody;
  try {
    body = (await request.json()) as PrintRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ ok: false, error: "printer_not_found" }, { status: 404 });

  const documentType = documentTypeOf(body);
  const explicitId = typeof body.printerId === "string" && body.printerId ? body.printerId : null;
  const printer = explicitId
    ? await loadPrinterForJob(location.id, explicitId)
    : documentType
      ? await resolvePrinterForLocation(location.id, documentType, null)
      : null;
  if (!printer) {
    return NextResponse.json(
      { ok: false, error: explicitId ? "printer_not_found" : "printer_not_configured" },
      { status: explicitId ? 404 : 409 },
    );
  }

  const refusal = printerRefusal(printer);
  if (refusal) return NextResponse.json({ ok: false, error: refusal }, { status: 409 });

  const target = printerTargetOf(printer.connection);
  if (!target) return NextResponse.json({ ok: false, error: "reconnect_required" }, { status: 409 });

  const job = parseJob(body.job);
  if (!job) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  if ((job.type === "document" && PAPERS[job.paper].kind === "sheet") && target.type !== "windows") {
    return NextResponse.json({ ok: false, error: "incompatible_printer" }, { status: 409 });
  }

  try {
    const prepared = await preparePrint(printer, job);
    const requestId = typeof body.printRequestId === "string" ? body.printRequestId.slice(0, 80) : "";
    if (requestId) {
      try {
        await query(
          `INSERT INTO print_jobs (location_id, document_type, entity_id, printer_id, status, print_request_id)
           VALUES ($1, $2, $3, $4, 'sending', $5)
           ON CONFLICT (location_id, print_request_id) DO NOTHING`,
          [location.id, body.documentType || job.type, body.entityId ?? null, printer.id, requestId],
        );
      } catch (err) {
        console.error("print job row skipped", err);
      }
    }
    console.info(
      JSON.stringify({
        event: "print_render",
        locationId: location.id,
        printerId: printer.id,
        delivery: prepared.delivery,
        bytes: prepared.bytes.length,
      }),
    );
    return NextResponse.json({
      ok: true,
      target,
      delivery: prepared.delivery,
      printerId: printer.id,
      printerName: printer.name,
      supportsDrawer: printer.connection.openDrawer === true,
      dataBase64: Buffer.from(prepared.bytes).toString("base64"),
    });
  } catch (err) {
    console.error("print render failed", err);
    return NextResponse.json({ ok: false, error: "render_failed" }, { status: 502 });
  }
});

function documentTypeOf(body: PrintRequestBody): "receipt" | "invoice" | "kitchen" | "label" | null {
  if (body.documentType === "receipt" || body.documentType === "invoice" || body.documentType === "kitchen" || body.documentType === "label") {
    return body.documentType;
  }
  if (body.job?.type === "kitchen-ticket") return "kitchen";
  if (body.job?.type === "label") return "label";
  if (body.job?.type === "receipt") return "receipt";
  if (body.job?.type === "document" && (body.job.paper === "a4" || body.job.paper === "a5")) return "invoice";
  return null;
}

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
      if (!paper || !PAPERS[paper]) return null;
      return { type: "document", html, paper };
    }
    default:
      return null;
  }
}
