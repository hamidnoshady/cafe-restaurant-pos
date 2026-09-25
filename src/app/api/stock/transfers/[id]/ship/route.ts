import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { shipItemTransfer, RetailStockError } from "@/lib/retail-stock-service";

export const POST = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const { id } = await ctx.params;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await shipItemTransfer(client, { businessId: session.businessId, transferId: id, actorId: session.sub });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ارسال انتقال ناموفق بود.";
    return NextResponse.json({ error: "ship_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
