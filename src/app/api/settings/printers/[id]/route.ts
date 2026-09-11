import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import type { PrinterConnection } from "@/lib/printer-connection";
import { parsePrinterInput } from "@/lib/printer-input";
import { resolveActiveLocation } from "@/lib/setup-state";

interface StoredPrinter extends Record<string, unknown> {
  id: string;
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  is_active: boolean;
}

async function scopedPrinter(id: string, locationId: string): Promise<StoredPrinter | null> {
  const { rows } = await query<StoredPrinter>(
    "SELECT id, name, kind, connection, is_active FROM printers WHERE id = $1 AND location_id = $2",
    [id, locationId],
  );
  return rows[0] ?? null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { id } = await context.params;
  const existing = await scopedPrinter(id, location.id);
  if (!existing) return NextResponse.json({ error: "printer_not_found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = parsePrinterInput(body, existing);
  if (!input) return NextResponse.json({ error: "invalid_printer" }, { status: 400 });

  if (input.isDefault) {
    await query(
      `UPDATE printers
          SET connection = jsonb_set(COALESCE(connection, '{}'::jsonb), '{isDefault}', 'false'::jsonb, true)
        WHERE location_id = $1 AND kind = $2 AND id <> $3`,
      [location.id, input.kind, id],
    );
  }
  const { rows } = await query(
    `UPDATE printers
        SET name = $1, kind = $2, connection = $3, is_active = $4
      WHERE id = $5 AND location_id = $6
      RETURNING id, name, kind, connection, is_active`,
    [input.name, input.kind, JSON.stringify(input.connection), input.isActive, id, location.id],
  );
  return NextResponse.json({ printer: rows[0] });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const { id } = await context.params;
  const { rows } = await query("DELETE FROM printers WHERE id = $1 AND location_id = $2 RETURNING id", [id, location.id]);
  if (rows.length === 0) return NextResponse.json({ error: "printer_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
