import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { sellThroughByCollection } from "@/lib/merchandising-service";

const EVENT_PREFIX: Record<string, string> = {
  accessories: "accessory",
  cosmetics: "cosmetic",
};

/** Sell-through by collection/season, off the same sale events the sales report reads. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  if (!industry || !EVENT_PREFIX[industry]) {
    return NextResponse.json({ error: "industry_unavailable" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [] });

  const from = request.nextUrl.searchParams.get("from") ?? undefined;
  const to = request.nextUrl.searchParams.get("to") ?? undefined;
  const rows = await sellThroughByCollection(session.businessId, location.id, {
    from,
    to,
    eventPrefix: EVENT_PREFIX[industry],
  });
  return NextResponse.json({ rows });
});
