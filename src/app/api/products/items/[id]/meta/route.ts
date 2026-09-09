import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, updateItemMeta, type ItemMetaPatch } from "@/lib/items-service";

/**
 * The add/edit product form's write path for the Phase 42 product columns —
 * name, barcode, units, ordering hints, tax percents, sellability. Stock and
 * pricing stay with each trade's own `/api/<trade>/items/[id]/stock`, the one
 * writer the receipt and sale paths already trust.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;
    const industryError = await requireProductWorkspaceForApi(session);
    if (industryError) return industryError;

    const { id } = await context.params;
    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
    const item = await getItem(id);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    }

    let body: ItemMetaPatch;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    const numeric = (value: unknown) =>
      value === null || value === undefined || value === "" ? null : Number(value);
    for (const key of [
      "conversionFactor",
      "minOrderQty",
      "reorderReminderQty",
      "leadTimeDays",
      "taxSalePercent",
      "taxPurchasePercent",
    ] as const) {
      const converted = numeric(body[key]);
      if (converted !== null && !Number.isFinite(converted)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      (body as Record<string, unknown>)[key] = converted;
    }

    const updated = await updateItemMeta(id, body);
    if (!updated) return NextResponse.json({ error: "item_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, item: updated });
  },
);
