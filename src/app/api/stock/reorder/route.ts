import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { setReorderPoint, RetailStockError } from "@/lib/retail-stock-service";

/** Sets a variant's reorder point (0 = not tracked). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { itemId?: string; reorderPoint?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.itemId || typeof body.reorderPoint !== "number") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const stock = await setReorderPoint(body.itemId, body.reorderPoint);
    return NextResponse.json({ ok: true, stock });
  } catch (err) {
    const message = err instanceof RetailStockError || err instanceof Error ? err.message : "ثبت نقطهٔ سفارش ناموفق بود.";
    return NextResponse.json({ error: "reorder_failed", message }, { status: 400 });
  }
});
