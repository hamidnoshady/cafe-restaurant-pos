import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { updateItemProfile } from "@/lib/item-brands-service";
import { recordItemEvent } from "@/lib/item-audit-service";

async function ownedItem(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) return null;
  return item;
}

/** Sets an item's brand, regulatory fields (IRC/پروانه بهداشت/ثبت اصالت) and skin/hair-type tags. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;
  const { id } = await context.params;

  const item = await ownedItem(session, id);
  if (!item) return NextResponse.json({ error: "item_not_found" }, { status: 404 });

  let body: {
    brandId?: string | null;
    ircCode?: string | null;
    healthPermit?: string | null;
    authenticityRegistration?: string | null;
    tags?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await updateItemProfile(id, {
    brandId: body.brandId,
    ircCode: body.ircCode,
    healthPermit: body.healthPermit,
    authenticityRegistration: body.authenticityRegistration,
    tags: Array.isArray(body.tags) ? body.tags : [],
  });
  await recordItemEvent({
    businessId: session.businessId,
    locationId: item.locationId,
    itemId: id,
    eventType: "item.profile_changed",
    payload: {
      brandId: body.brandId ?? null,
      ircCode: body.ircCode ?? null,
      healthPermit: body.healthPermit ?? null,
      authenticityRegistration: body.authenticityRegistration ?? null,
      tags: Array.isArray(body.tags) ? body.tags : [],
    },
    createdBy: session.sub,
  });
  return NextResponse.json({ ok: true });
});
