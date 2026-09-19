import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { normalizeStoredConnection, printerTargetOf } from "@/lib/printing/types";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * The operational printer list — what the POS/waiter/kitchen screens call at
 * checkout / send-to-kitchen time to find the printer to print through. Every
 * role that can trigger a print needs read access to it.
 *
 * Callers get printer IDs (plus enough to describe them), never hardware
 * targets to construct: actual printing goes through POST /api/printing/print,
 * which loads the printer for the caller's active location server-side. A
 * `needsReconnect` row is a legacy pairing the new architecture cannot use;
 * the UI asks for one new pairing instead of guessing.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  const { rows } = await query(
    `SELECT id, name, kind, connection FROM printers
      WHERE location_id = $1 AND is_active
      ORDER BY kind, COALESCE(connection @> '{"isDefault": true}'::jsonb, false) DESC, name`,
    [location.id],
  );

  const printers = (rows as Record<string, unknown>[]).map((row) => {
    const connection = normalizeStoredConnection(row.connection);
    return {
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind),
      isDefault: connection.isDefault === true,
      needsReconnect: connection.needsReconnect === true,
      target: printerTargetOf(connection),
    };
  });
  return NextResponse.json({ printers });
});
