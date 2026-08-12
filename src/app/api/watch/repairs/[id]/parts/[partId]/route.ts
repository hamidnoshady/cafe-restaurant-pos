import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getRepairTicket, removeRepairPart } from "@/lib/repairs-service";

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string; partId: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;
    const industryError = await requireIndustryForApi(session, "watch");
    if (industryError) return industryError;
    const { id, partId } = await context.params;

    const location = await resolveActiveLocation(session);
    const ticket = await getRepairTicket(id);
    if (!location || !ticket || ticket.locationId !== location.id) {
      return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
    }

    try {
      await removeRepairPart(partId);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
    }
  },
);
