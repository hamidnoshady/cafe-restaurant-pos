import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createInstallmentPlan,
  InstallmentError,
  listInstallmentPlans,
  MissingLedgerAccountError,
  type InstallmentDirection,
} from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/** The installment card: receivable plans by default, payable on request. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const directionParam = request.nextUrl.searchParams.get("direction");
  const direction: InstallmentDirection = directionParam === "payable" ? "payable" : "receivable";
  const statusParam = request.nextUrl.searchParams.get("status");
  const status = statusParam === "open" || statusParam === "settled" || statusParam === "overdue" ? statusParam : "all";
  const q = request.nextUrl.searchParams.get("q") ?? undefined;

  const plans = await listInstallmentPlans(session.businessId, { direction, q, status });
  return NextResponse.json({ plans });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPost);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.direction !== "receivable" && body.direction !== "payable") {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }
  if (body.source !== "party" && body.source !== "invoice") {
    return NextResponse.json({ error: "invalid_source" }, { status: 400 });
  }
  const direction: InstallmentDirection = body.direction;
  const source = body.source;

  const location = await resolveActiveLocation(session);

  try {
    const plan = await createInstallmentPlan({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      direction,
      source,
      partyId: typeof body.partyId === "string" ? body.partyId : null,
      invoiceOrderId: typeof body.invoiceOrderId === "string" ? body.invoiceOrderId : null,
      principal: Number(body.principal ?? 0),
      downPayment: Number(body.downPayment ?? 0),
      interestPercent: Number(body.interestPercent ?? 0),
      lateFeePercent: Number(body.lateFeePercent ?? 0),
      installmentCount: Number(body.installmentCount ?? 0),
      intervalMonths: Number(body.intervalMonths ?? 1),
      firstDueDate: typeof body.firstDueDate === "string" ? body.firstDueDate : "",
      note: typeof body.note === "string" ? body.note : null,
      createdBy: session.sub,
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    if (err instanceof InstallmentError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
