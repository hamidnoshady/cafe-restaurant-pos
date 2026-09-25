import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteDeal, getDeal, moveDealStage } from "@/lib/crm-service";
import { defaultPipeline, dealStageHistory, moveDealToStage } from "@/lib/crm-pipeline-service";
import { isDealStage, type DealStage } from "@/lib/crm-shared";
import { isUuid } from "@/lib/uuid";

/**
 * One deal. `PATCH` is the kanban's drag — a stage move and nothing else.
 *
 * No `GET`: the board holds every card it shows, and a single-deal read
 * existed only as an unused twin of the board's own data.
 *
 * Separate from the full upsert because dragging a card is one small,
 * frequent, well-defined act, and routing it through a whole-object PUT is how
 * a drag ends up clearing the fields the browser did not happen to be holding.
 * `closed_at` is maintained by the service, in both directions.
 *
 * ## Two accepted shapes, on purpose
 *
 * `stageId` is the current one: a real stage row in a configurable pipeline,
 * which records stage history and dwell time.
 *
 * `stage` is the legacy six-value key («lead», «won», …). It is still accepted
 * because bookmarked URLs, an older cached bundle in somebody's browser and
 * any external caller written against the previous API all send it, and
 * silently rejecting them would break a working integration to gain nothing.
 * It is resolved to a real stage in the default pipeline and then takes the
 * same path, so a legacy caller gets stage history too.
 *
 * **No stage move posts to the ledger, including a move to won.** A deal is a
 * forecast; the sale is a separate, deliberate act in Accounting.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    let body: { stageId?: string; stage?: string; lostReason?: string; note?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });

    // Resolve whichever shape arrived into one stage id.
    let stageId = body.stageId;
    if (stageId !== undefined && !isUuid(stageId)) {
      return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
    }
    if (!stageId) {
      if (!body.stage || !isDealStage(body.stage)) {
        return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
      }
      const pipeline = await defaultPipeline(session.businessId);
      const match = pipeline?.stages.find((stage) => stage.legacyKey === body.stage);
      if (!match) {
        // The business renamed or removed the stage this legacy key refers to.
        // Fall back to the old column-based move rather than failing: the
        // caller's intent is still expressible, it just no longer maps onto
        // this pipeline's board.
        const moved = await moveDealStage(session.businessId, id, body.stage as DealStage, {
          lostReason: body.lostReason,
        });
        if (!moved) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
        return NextResponse.json({ deal: await getDeal(session.businessId, id) });
      }
      stageId = match.id;
    }

    const result = await moveDealToStage(
      session.businessId,
      id,
      stageId,
      { name: session.fullName, userId: session.sub },
      { lostReason: body.lostReason, note: body.note },
    );
    if (!result.ok) {
      // `same_stage` is not an error worth surfacing: a drag that ends where
      // it started is a no-op, and the client should see the deal unchanged
      // rather than a red banner for having changed nothing.
      if (result.error === "same_stage") {
        return NextResponse.json({ deal: await getDeal(session.businessId, id) });
      }
      const status = result.error === "stage_not_found" ? 400 : 404;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json({
      deal: await getDeal(session.businessId, id),
      secondsInPreviousStage: result.secondsInPreviousStage ?? null,
      history: await dealStageHistory(session.businessId, id),
    });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteDeal(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "deal_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
