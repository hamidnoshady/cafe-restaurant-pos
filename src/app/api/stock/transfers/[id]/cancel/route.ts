import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { cancelItemTransfer, RetailStockError } from "@/lib/retail-stock-service";

export const POST = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { id } = await ctx.params;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await cancelItemTransfer(client, { businessId: session.businessId, transferId: id, actorId: session.sub });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "لغو انتقال ناموفق بود.";
    return NextResponse.json({ error: "cancel_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
