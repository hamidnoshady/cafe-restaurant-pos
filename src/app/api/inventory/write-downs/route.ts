import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { rialText } from "@/lib/inventory-exact";
import { createNrvWriteDown } from "@/lib/nrv-service";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: {
    valuationDate?: string; reason?: string; idempotencyKey?: string;
    lines?: Array<{ inventoryItemId?: string; nrvValueRial?: string }>;
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  try {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await createNrvWriteDown(client, {
        businessId: session.businessId, locationId: location.id, createdBy: session.sub,
        valuationDate: body.valuationDate ?? "", reason: body.reason ?? "",
        idempotencyKey: body.idempotencyKey ?? "",
        lines: (body.lines ?? []).map((line) => ({
          inventoryItemId: line.inventoryItemId ?? "", nrvValueRial: rialText(line.nrvValueRial ?? ""),
        })),
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally { client.release(); }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
});
