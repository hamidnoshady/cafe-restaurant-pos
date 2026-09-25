import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireCapabilityForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { lookupBarcode } from "@/lib/item-barcodes-service";

/**
 * Resolve a scanned code to the item(s) it names at this branch.
 *
 * Deliberately returns every match rather than guessing: a code that somehow
 * got attached to two items (or a watch serial) is surfaced to the cashier,
 * never silently resolved to one of them.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const capabilityError = await requireCapabilityForApi(session, "barcode");
  if (capabilityError) return capabilityError;

  const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const matches = await lookupBarcode(location.id, code);
  return NextResponse.json({ matches });
});
