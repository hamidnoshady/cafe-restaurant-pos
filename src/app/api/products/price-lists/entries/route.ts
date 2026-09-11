import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { savePriceEntries, type EntryUpdate } from "@/lib/price-lists-service";

/** One «ذخیره قیمت‌ها» press: upserts filled cells, clears emptied ones. */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
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
    if (!update.priceListId || !update.itemId || (update.price != null && !Number.isFinite(update.price))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const touched = await savePriceEntries(updates);
  return NextResponse.json({ ok: true, touched });
});
