import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

const DOCUMENTS = new Set(["receipt", "invoice", "kitchen", "label"]);

/** Branch print rules: which template and printer a document uses. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rules: [] });
  try {
    const { rows } = await query(
      `SELECT document_type, template_key, template_id, printer_id, fallback_printer_id
         FROM print_rules WHERE location_id = $1 ORDER BY document_type`,
      [location.id],
    );
    return NextResponse.json({ rules: rows });
  } catch (err) {
    console.error("listing print rules failed", err);
    return NextResponse.json({ error: "print_rules_failed", rules: [] }, { status: 500 });
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: { documentType?: string; templateKey?: string | null; printerId?: string | null; fallbackPrinterId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.documentType || !DOCUMENTS.has(body.documentType)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const templateKey = typeof body.templateKey === "string" ? body.templateKey.slice(0, 64) : null;
  try {
    await query(
      `INSERT INTO print_rules (location_id, document_type, template_key, printer_id, fallback_printer_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (location_id, document_type) DO UPDATE
         SET template_key = EXCLUDED.template_key,
             printer_id = EXCLUDED.printer_id,
             fallback_printer_id = EXCLUDED.fallback_printer_id,
             updated_at = now()`,
      [location.id, body.documentType, templateKey, body.printerId || null, body.fallbackPrinterId || null],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("saving print rule failed", err);
    return NextResponse.json({ error: "print_rules_failed" }, { status: 500 });
  }
});
