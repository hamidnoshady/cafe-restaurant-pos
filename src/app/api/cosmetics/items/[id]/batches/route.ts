import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { receiveBatch } from "@/lib/cosmetics-service";
import { recordItemEvent } from "@/lib/item-audit-service";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) return null;
  return item;
}

/** Receives one batch of a batch-tracked item, rolling item_stock forward as the sum of its batches. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;
  const { id } = await context.params;

  const item = await ownedItem(session, id);
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: {
    batchNumber?: string;
    expiryDate?: string | null;
    quantity?: string;
    unitCost?: number;
    supplierReference?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const batch = await receiveBatch(client, {
      itemId: id,
      batchNumber: body.batchNumber ?? "",
      expiryDate: body.expiryDate ?? null,
      quantity: String(body.quantity ?? "0"),
      unitCost: Number(body.unitCost ?? 0),
      supplierReference: body.supplierReference ?? null,
    });
    await recordItemEvent({
      businessId: session.businessId,
      locationId: item.locationId,
      itemId: id,
      eventType: "item.batch_received",
      payload: {
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity: batch.quantity,
        unitCost: batch.unitCost,
      },
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, batch });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
