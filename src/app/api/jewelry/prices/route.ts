import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { listCurrentGoldPrices, recordGoldPrice } from "@/lib/gold-prices-service";

/** Today's (or the latest recorded) price board, one row per purity. */
  // Cashier reads only: the invoice screen prices a piece from the day's
  // rate, so it has to be able to see it. Recording a rate stays owner/manager.
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const prices = await listCurrentGoldPrices(session.businessId);
  return NextResponse.json({ prices });
});

/** Records (or replaces) today's price/gram for one purity -- manual entry; no external feed is wired up yet. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  let body: { purity?: string; pricePerGram?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const price = await recordGoldPrice({
      businessId: session.businessId,
      purity: body.purity ?? "",
      pricePerGram: Number(body.pricePerGram),
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, price });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
