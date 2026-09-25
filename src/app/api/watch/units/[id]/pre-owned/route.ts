import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getSerial } from "@/lib/items-service";
import { recordPreOwnedIntake } from "@/lib/watch-crm-service";
import { CONDITION_GRADES, type ConditionGrade } from "@/lib/watch";

/** Records a pre-owned intake's provenance on the unit: condition grade and the box-and-papers checklist. */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id } = await context.params;

    const location = await resolveActiveLocation(session);
    const serial = await getSerial(id);
    if (!location || !serial) {
      return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
    }
    const item = await getItem(serial.itemId);
    if (!item || item.locationId !== location.id) {
      return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
    }

    let body: { conditionGrade?: string; boxAndPapers?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (!body.conditionGrade || !(CONDITION_GRADES as string[]).includes(body.conditionGrade)) {
      return NextResponse.json({ error: "invalid_condition_grade" }, { status: 400 });
    }

    try {
      await recordPreOwnedIntake(id, {
        conditionGrade: body.conditionGrade as ConditionGrade,
        boxAndPapers: Boolean(body.boxAndPapers),
      });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
    }
  },
);
