import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deleteDeal, getDeal, moveDealStage } from "@/lib/crm-service";
import { isDealStage, type DealStage } from "@/lib/crm-shared";

/** One deal. `PATCH` is the kanban's drag — a stage move and nothing else. */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;

    const { id } = await params;
    const deal = await getDeal(session.businessId, id);
    if (!deal) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
    return NextResponse.json({ deal });
  },
);

/**
 * Move a deal to another stage.
 *
 * Separate from the full upsert because dragging a card is one small,
 * frequent, well-defined act, and routing it through a whole-object PUT is how
 * a drag ends up clearing the fields the browser did not happen to be holding.
 * `closed_at` is maintained by the service, in both directions.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;

    let body: { stage?: string; lostReason?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.stage || !isDealStage(body.stage)) {
      return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
    }

    const { id } = await params;
    const moved = await moveDealStage(session.businessId, id, body.stage as DealStage, {
      lostReason: body.lostReason,
    });
    if (!moved) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
    return NextResponse.json({ deal: await getDeal(session.businessId, id) });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteDeal(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
