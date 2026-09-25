import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getGoldPrice } from "@/lib/gold-prices-service";
import { buyBackGold, JewelryFlagshipError } from "@/lib/jewelry-flagship-service";
import { isPurity } from "@/lib/gold";

/** Buys scrap/second-hand gold at the day's buy rate, creating a scrap weight item. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { purity?: string; grossWeight?: string; karsorPercent?: number; customerId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isPurity(body.purity ?? "")) return NextResponse.json({ error: "invalid_purity" }, { status: 400 });

  const price = await getGoldPrice(session.businessId, body.purity!);
  if (!price?.buyPricePerGram) {
    return NextResponse.json({ error: "no_buy_rate", message: "نرخ خرید امروز برای این عیار ثبت نشده است." }, { status: 409 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await buyBackGold(client, {
      businessId: session.businessId,
      locationId: location.id,
      customerId: typeof body.customerId === "string" ? body.customerId : null,
      purity: body.purity as never,
      grossWeight: String(body.grossWeight ?? ""),
      karsorPercent: Number(body.karsorPercent ?? 0),
      buyPricePerGram: price.buyPricePerGram,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "خرید طلا ناموفق بود.";
    return NextResponse.json({ error: "buy_back_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
