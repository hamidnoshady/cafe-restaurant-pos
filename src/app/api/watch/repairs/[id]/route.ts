import { NextRequest, NextResponse } from "next/server";
import { requireRole, type SessionPayload, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  getRepairTicket,
  listRepairParts,
  setRepairStatus,
  updateRepairTicket,
} from "@/lib/repairs-service";
import { REPAIR_STATUSES, type RepairStatus } from "@/lib/watch";

async function ownedTicket(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const ticket = await getRepairTicket(id);
  if (!ticket || ticket.locationId !== location.id) return null;
  return ticket;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const ticket = await ownedTicket(session, id);
  if (!ticket) return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });

  const parts = await listRepairParts(id);
  return NextResponse.json({ ticket, parts });
});

/** Moves the ticket along the workflow and/or edits the charges agreed with the customer. Closing is its own route — it posts to the ledger. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const ticket = await ownedTicket(session, id);
  if (!ticket) return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });

  let body: { status?: string; laborCharge?: number; vatPercent?: number; reportedIssue?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (body.laborCharge != null || body.vatPercent != null || body.reportedIssue != null) {
      await updateRepairTicket(id, {
        laborCharge: body.laborCharge,
        vatPercent: body.vatPercent,
        reportedIssue: body.reportedIssue ?? undefined,
      });
    }
    if (body.status) {
      if (!REPAIR_STATUSES.includes(body.status as RepairStatus)) {
        return NextResponse.json({ error: "invalid_status" }, { status: 400 });
      }
      await setRepairStatus(id, body.status as RepairStatus);
    }
    return NextResponse.json({ ok: true, ticket: await getRepairTicket(id) });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
