import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { lookupBarcode } from "@/lib/inventory-item-barcodes-service";

/**
 * Resolve a scanned code to the ingredient it names at this branch — the read
 * a scan-driven stock count makes once per scan, so it stays a single indexed
 * lookup on (location_id, code) and nothing more.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  return NextResponse.json({ matches: await lookupBarcode(location.id, code) });
});
