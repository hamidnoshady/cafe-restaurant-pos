import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import type { PrinterConnection } from "@/lib/printer-connection";
import { resolveActiveLocation } from "@/lib/setup-state";

interface PrinterInput {
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  isActive: boolean;
  isDefault: boolean;
}

function parseInput(body: Record<string, unknown>, fallback?: { name: string; kind: "receipt" | "kitchen"; connection: PrinterConnection; is_active: boolean }): PrinterInput | null {
  const nameValue = body.name ?? fallback?.name;
  const name = typeof nameValue === "string" ? nameValue.trim() : "";
  const kindValue = body.kind ?? fallback?.kind;
  const kind = kindValue === "kitchen" ? "kitchen" : kindValue === "receipt" ? "receipt" : null;
  const existing: PrinterConnection = fallback?.connection ?? {};
  const ipValue = body.ip ?? existing.ip;
  const ip = typeof ipValue === "string" ? ipValue.trim() : "";
  const port = Number(body.port ?? existing.port ?? 9100);
  const paperWidthMm = Number(body.paperWidthMm ?? existing.paperWidthMm ?? 80);
  const isActive = typeof body.isActive === "boolean" ? body.isActive : (fallback?.is_active ?? true);
  const isDefault = (typeof body.isDefault === "boolean" ? body.isDefault : (existing.isDefault === true)) && isActive;

  if (!name || !kind || !ip || ip.length > 255 || !Number.isInteger(port) || port < 1 || port > 65535 || (paperWidthMm !== 58 && paperWidthMm !== 80)) {
    return null;
  }
  return {
    name,
    kind,
    isActive,
    isDefault,
    connection: { ...existing, ip, port, paperWidthMm: paperWidthMm as 58 | 80, isDefault },
  };
}

/** All hardware for the active branch, including inactive printers. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  const { rows: printers } = await query(
    `SELECT id, name, kind, connection, is_active
       FROM printers
      WHERE location_id = $1
      ORDER BY kind, COALESCE((connection->>'isDefault')::boolean, false) DESC, name`,
    [location.id],
  );
  return NextResponse.json({ printers });
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
  const input = parseInput(body);
  if (!input) return NextResponse.json({ error: "invalid_printer" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (input.isDefault) {
    await query(
      `UPDATE printers
          SET connection = jsonb_set(COALESCE(connection, '{}'::jsonb), '{isDefault}', 'false'::jsonb, true)
        WHERE location_id = $1 AND kind = $2`,
      [location.id, input.kind],
    );
  }
  const { rows } = await query(
    `INSERT INTO printers (location_id, name, kind, connection, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, kind, connection, is_active`,
    [location.id, input.name, input.kind, JSON.stringify(input.connection), input.isActive],
  );
  return NextResponse.json({ printer: rows[0] }, { status: 201 });
});
