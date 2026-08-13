import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { itemAuditTrail } from "@/lib/industry-reports-service";

/**
 * Everything that has ever happened to one item, in order. Shared by all
 * three Phase 21 industries rather than duplicated per industry — the
 * timeline is read from the same `domain_events` log whichever industry
 * wrote it, and the guard that matters is the one below: the item has to
 * belong to the branch this caller is scoped to. F&B is excluded because
 * it has no `items` rows at all (its own catalogue is `menu_items`/
 * `inventory_items`, never migrated onto this model).
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const industry = await getBusinessIndustry(session.businessId);
  if (!industry || industry === "food_service") {
    return NextResponse.json({ error: "industry_mismatch" }, { status: 403 });
  }

  const location = await resolveActiveLocation(session);
  const item = await getItem(id);
  if (!location || !item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  const trail = await itemAuditTrail(session.businessId, id);
  return NextResponse.json({ item, trail });
});
