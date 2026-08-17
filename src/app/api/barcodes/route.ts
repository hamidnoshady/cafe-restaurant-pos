import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { assignBarcode, listBarcodes } from "@/lib/item-barcodes-service";

/**
 * Barcode assignment for every retail trade that has the `barcode` capability.
 *
 * Gated on the capability rather than a named industry (or the sales model):
 * it lives inside each trade's own module, so `requireIndustryForApi`'s
 * exact-match check cannot name it, and `capabilities` is the one place the
 * four trades switch it on.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "barcode");
  if (capabilityError) return capabilityError;

  let body: { itemId?: string; code?: string | null; symbology?: string | null; note?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!itemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const item = await getItem(itemId);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  try {
    const barcode = await assignBarcode(itemId, {
      code: typeof body.code === "string" ? body.code : null,
      symbology: typeof body.symbology === "string" ? (body.symbology as "EAN13" | "UPC" | "internal") : null,
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ ok: true, barcode });
  } catch (err) {
    return NextResponse.json({ error: "barcode_failed", message: (err as Error).message }, { status: 400 });
  }
});

/** Every code stuck to one item, for the label/management screen. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "barcode");
  if (capabilityError) return capabilityError;

  const itemId = request.nextUrl.searchParams.get("itemId") ?? "";
  if (!itemId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const item = await getItem(itemId);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  return NextResponse.json({ barcodes: await listBarcodes(itemId) });
});
