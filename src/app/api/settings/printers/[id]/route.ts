import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { normalizeStoredConnection, type StoredPrinterConnection, type PrinterPurpose } from "@/lib/printing/types";
import { connectionJsonFor, parsePrinterInput } from "@/lib/printing/printer-input";
import { resolveActiveLocation } from "@/lib/setup-state";

interface StoredPrinter extends Record<string, unknown> {
  id: string;
  name: string;
  kind: PrinterPurpose;
  connection: StoredPrinterConnection;
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
  // A legacy row that needs reconnection has no canonical hardware target to
  // merge onto — re-pairing (a fresh `connection`) is the only valid edit,
  // which the UI's reconnect flow sends.
  const input = parsePrinterInput(body, {
    name: existing.name,
    kind: existing.kind,
    connection: existing.connection as Record<string, unknown>,
    is_active: existing.is_active,
  });
  if (!input) return NextResponse.json({ error: "invalid_printer" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(
        `UPDATE printers
            SET connection =
              CASE WHEN jsonb_typeof(connection) = 'object' THEN connection ELSE '{}'::jsonb END
              || '{"isDefault": false}'::jsonb
          WHERE location_id = $1 AND kind = $2 AND id <> $3`,
        [location.id, input.kind, id],
      );
    }
    const { rows } = await client.query(
      `UPDATE printers
          SET name = $1, kind = $2, connection = $3, is_active = $4
        WHERE id = $5 AND location_id = $6
        RETURNING id, name, kind, connection, is_active`,
      [input.name, input.kind, JSON.stringify(connectionJsonFor(input)), input.isActive, id, location.id],
    );
    await client.query("COMMIT");
    return NextResponse.json({ printer: rows[0] });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("updating printer failed", err);
    return NextResponse.json({ error: "printer_save_failed" }, { status: 500 });
  } finally {
    client.release();
  }
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
