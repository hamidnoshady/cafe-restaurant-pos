import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { connectionJsonFor, parsePrinterInput } from "@/lib/printing/printer-input";
import { resolveActiveLocation } from "@/lib/setup-state";

/** All hardware for the active branch, including inactive printers. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  try {
    const { rows: printers } = await query(
      `SELECT id, name, kind, connection, is_active
         FROM printers
        WHERE location_id = $1
        -- JSON containment is deliberately used instead of casting ->> to
        -- boolean. A legacy/imported row with a malformed isDefault value must
        -- not make the entire settings page return 500.
        ORDER BY kind, COALESCE(connection @> '{"isDefault": true}'::jsonb, false) DESC, name`,
      [location.id],
    );
    return NextResponse.json({ printers });
  } catch (err) {
    console.error("listing printers failed", err);
    return NextResponse.json({ error: "printer_list_failed", printers: [] }, { status: 500 });
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = parsePrinterInput(body);
  if (!input) return NextResponse.json({ error: "invalid_printer" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (input.isDefault) {
      await client.query(
        `UPDATE printers
            SET connection =
              CASE WHEN jsonb_typeof(connection) = 'object' THEN connection ELSE '{}'::jsonb END
              || '{"isDefault": false}'::jsonb
          WHERE location_id = $1 AND kind = $2`,
        [location.id, input.kind],
      );
    }
    const { rows } = await client.query(
      `INSERT INTO printers (location_id, name, kind, connection, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, kind, connection, is_active`,
      [location.id, input.name, input.kind, JSON.stringify(connectionJsonFor(input)), input.isActive],
    );
    await client.query("COMMIT");
    return NextResponse.json({ printer: rows[0] }, { status: 201 });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Keep database details out of the response but leave an actionable code
    // in the UI and the real failure in server logs.
    console.error("saving printer failed", err);
    return NextResponse.json({ error: "printer_save_failed" }, { status: 500 });
  } finally {
    client.release();
  }
});
