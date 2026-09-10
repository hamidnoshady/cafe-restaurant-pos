import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  createReconciliation,
  ReconciliationError,
  listReconciliations,
  RECONCILABLE_ACCOUNTS,
  type ReconcilableAccount,
} from "@/lib/reconciliation-service";

/**
 * The reconcilable set lives in the service (`RECONCILABLE_ACCOUNTS`) so the
 * route cannot fall behind it — the local copy here was still two entries long
 * after بانک became a posted-to account.
 */
const ACCOUNT_CODES: readonly ReconcilableAccount[] = RECONCILABLE_ACCOUNTS;

/** A reconciliation history, or the current one, for ?accountCode=cash|bank|bankClearing. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const accountCode = request.nextUrl.searchParams.get("accountCode") as ReconcilableAccount | null;
  if (!accountCode || !ACCOUNT_CODES.includes(accountCode)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }
  return NextResponse.json({ reconciliations: await listReconciliations(session.businessId, accountCode) });
});

interface CreateBody {
  accountCode?: string;
  statementDate?: string;
  statementBalance?: number;
}

/** Starts a new reconciliation for an account. Only one may be in progress per account at a time. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!ACCOUNT_CODES.includes(body.accountCode as ReconcilableAccount)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }
  if (!body.statementDate?.trim()) {
    return NextResponse.json({ error: "statement_date_required" }, { status: 400 });
  }
  const statementBalance = Number(body.statementBalance);
  if (!Number.isSafeInteger(statementBalance)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const reconciliation = await createReconciliation({
      businessId: session.businessId,
      accountCode: body.accountCode as ReconcilableAccount,
      statementDate: body.statementDate.trim(),
      statementBalance,
      createdBy: session.sub,
    });
    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
