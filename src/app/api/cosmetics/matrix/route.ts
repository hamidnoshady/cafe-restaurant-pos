import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createVariantMatrix } from "@/lib/cosmetics-service";
import type { MatrixAxis } from "@/lib/variant-matrix";

/** Bulk-creates a variant_parent and its N×M children over two axes (شید × حجم). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: {
    parentName?: string;
    parentSku?: string | null;
    axisA?: MatrixAxis;
    axisB?: MatrixAxis;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await createVariantMatrix({
      locationId: location.id,
      parentName: body.parentName ?? "",
      parentSku: body.parentSku,
      axisA: body.axisA ?? { name: "", values: [] },
      axisB: body.axisB ?? { name: "", values: [] },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
