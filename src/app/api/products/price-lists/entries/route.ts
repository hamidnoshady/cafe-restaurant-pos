import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { savePriceEntries, type EntryUpdate } from "@/lib/price-lists-service";

/** One «ذخیره قیمت‌ها» press: upserts filled cells, clears emptied ones. */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { updates?: EntryUpdate[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const updates = body.updates ?? [];
  if (!Array.isArray(updates) || updates.length > 2000) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  for (const update of updates) {
    if (
      !update ||
      typeof update.priceListId !== "string" ||
      typeof update.itemId !== "string" ||
      // `price` is Rial and the column is a `bigint CHECK (price >= 0)`. A
      // negative, fractional or out-of-range number is a bad request, not a
      // row to silently drop: the matrix would report "saved" and show the old
      // value again on the next read.
      (update.price != null &&
        (!Number.isFinite(update.price) ||
          update.price < 0 ||
          update.price > Number.MAX_SAFE_INTEGER))
    ) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const touched = await savePriceEntries(updates, location.id);
  return NextResponse.json({ ok: true, touched });
});
