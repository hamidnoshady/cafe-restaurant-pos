import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { rialText } from "@/lib/inventory-exact";
import { reverseNrvWriteDown } from "@/lib/nrv-service";
import { getPrimaryLocation } from "@/lib/setup-state";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  const location = await getPrimaryLocation(session.businessId);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  let body: { reason?: string; idempotencyKey?: string; amounts?: Array<{ inventoryItemId?: string; amountRial?: string }> };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseNrvWriteDown(client, {
      businessId: session.businessId, locationId: location.id, originalId: id,
      reason: body.reason ?? "", idempotencyKey: body.idempotencyKey ?? "", createdBy: session.sub,
      amounts: body.amounts?.map((line) => ({
        inventoryItemId: line.inventoryItemId ?? "", amountRial: rialText(line.amountRial ?? ""),
      })),
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  } finally { client.release(); }
}
