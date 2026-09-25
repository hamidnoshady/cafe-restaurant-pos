import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { openLayaway, JewelryFlagshipError } from "@/lib/jewelry-flagship-service";

/** This business's open layaway plans. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const { rows } = await query<{ id: string; plan_number: string; customer_name: string; grams: string; total_value_rial: string; paid_rial: string; status: string }>(
    `SELECT l.id, l.plan_number::text, c.name AS customer_name, l.grams::text, l.total_value_rial::text, l.paid_rial::text, l.status::text
       FROM layaway_plans l JOIN parties c ON c.id = l.customer_id
      WHERE l.business_id = $1
      ORDER BY l.created_at DESC
      LIMIT 100`,
    [session.businessId],
  );

  return NextResponse.json({
    plans: rows.map((r) => ({
      id: r.id,
      planNumber: Number(r.plan_number),
      customerName: r.customer_name,
      grams: r.grams,
      totalValueRial: Number(r.total_value_rial),
      paidRial: Number(r.paid_rial),
      status: r.status,
    })),
  });
});

/** Opens a gram-denominated layaway plan with a deposit. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { customerId?: string; itemId?: string | null; grams?: string; pricePerGram?: number; depositRial?: number; promisedDate?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.customerId || !body.grams) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await openLayaway(client, {
      businessId: session.businessId,
      locationId: location.id,
      customerId: body.customerId,
      itemId: typeof body.itemId === "string" ? body.itemId : null,
      grams: body.grams,
      pricePerGram: Number(body.pricePerGram ?? 0),
      depositRial: Number(body.depositRial ?? 0),
      promisedDate: body.promisedDate ?? null,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, plan });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "باز کردن لیاوی ناموفق بود.";
    return NextResponse.json({ error: "layaway_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
