import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { addRepairPart, getRepairTicket } from "@/lib/repairs-service";

/** Records a part consumed on a ticket: what it cost the shop, and what the customer is billed for it (zero on a warranty job). */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  const ticket = await getRepairTicket(id);
  if (!location || !ticket || ticket.locationId !== location.id) {
    return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
  }

  let body: { description?: string; quantity?: string; unitCost?: number; charge?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const part = await addRepairPart(id, {
      description: body.description ?? "",
      quantity: body.quantity ?? "1",
      unitCost: Number(body.unitCost ?? 0),
      charge: Number(body.charge ?? 0),
    });
    return NextResponse.json({ ok: true, part });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
