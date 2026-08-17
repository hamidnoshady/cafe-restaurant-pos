import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { writeOffExpiredBatches } from "@/lib/cosmetics-service";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) return null;
  return item;
}

/** Writes off an item's expired batches, posting their cost to «کالای منقضی و تستر». */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;
  const { id } = await context.params;

  const item = await ownedItem(session, id);
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await writeOffExpiredBatches(client, {
      businessId: session.businessId,
      locationId: item.locationId,
      itemId: id,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "write_off_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
