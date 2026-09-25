import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listDeals, upsertDeal } from "@/lib/crm-service";
import { isDealStage, type DealStage } from "@/lib/crm-shared";
import { tomanToRial } from "@/lib/money";

/**
 * The sales pipeline (Phase 36).
 *
 * Owner/manager only: a deal carries a revenue expectation and an owner's name,
 * which is forecasting data rather than floor data.
 *
 * **A deal posts no money.** `valueRial` is what someone expects to sell, not
 * what was sold; revenue appears when an order or invoice is settled through
 * the sales path that already posts correctly. Winning a deal here writes
 * nothing to the ledger — see the note on `crm_deals` in migration 0118. The
 * optional `orderId` is how a won deal points *at* the sale that realised it.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const stage = search.get("stage");
  const deals = await listDeals(session.businessId, {
    customerId: search.get("customerId") ?? undefined,
    stage: stage && isDealStage(stage) ? (stage as DealStage) : undefined,
    openOnly: search.get("open") === "1",
  });
  return NextResponse.json({ deals });
});

interface DealBody {
  id?: string;
  customerId?: string | null;
  title?: string;
  description?: string;
  stage?: string;
  /** The UI speaks Toman; storage is integer Rial. Converted here, once. */
  valueToman?: number;
  valueRial?: number;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerUser?: string;
  source?: string;
  lostReason?: string | null;
  orderId?: string | null;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  let body: DealBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "deal_title_required" }, { status: 400 });
  if (body.stage !== undefined && !isDealStage(body.stage)) {
    return NextResponse.json({ error: "deal_stage_invalid" }, { status: 400 });
  }
  if (
    body.probability !== undefined &&
    body.probability !== null &&
    (!Number.isFinite(body.probability) || body.probability < 0 || body.probability > 100)
  ) {
    return NextResponse.json({ error: "deal_probability_invalid" }, { status: 400 });
  }

  const valueRial =
    body.valueRial !== undefined
      ? Math.round(body.valueRial)
      : body.valueToman !== undefined
        ? tomanToRial(body.valueToman)
        : 0;
  if (!Number.isFinite(valueRial) || valueRial < 0) {
    return NextResponse.json({ error: "deal_value_invalid" }, { status: 400 });
  }

  const deal = await upsertDeal(session.businessId, {
    id: body.id,
    customerId: body.customerId ?? null,
    title,
    description: body.description,
    stage: body.stage as DealStage | undefined,
    valueRial,
    probability: body.probability,
    expectedCloseDate: body.expectedCloseDate ?? null,
    ownerUser: body.ownerUser,
    source: body.source,
    lostReason: body.lostReason ?? null,
    orderId: body.orderId ?? null,
    createdBy: session.fullName,
  });
  return NextResponse.json({ deal }, { status: body.id ? 200 : 201 });
});
