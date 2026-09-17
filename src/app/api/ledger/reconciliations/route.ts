import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  createReconciliation,
  getAccountOverview,
  ReconciliationError,
  listReconciliations,
} from "@/lib/reconciliation-service";
import { isIsoDate, isReconcilableAccount } from "@/lib/reconciliation";

/**
 * «تطبیق بانکی و صندوق» — the account's reconciliation history.
 *
 * The reconcilable set lives in `reconciliation.ts` (`isReconcilableAccount`)
 * so no route can fall behind it — the local copy here was still two entries
 * long after بانک became a posted-to account.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const accountCode = request.nextUrl.searchParams.get("accountCode");
  if (!isReconcilableAccount(accountCode)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }

  try {
    // The overview travels with the history: the "start a new one" form needs
    // the opening balance and the count of unmatched items to be worth filling
    // in, and fetching it separately doubled the screen's round trips for two
    // numbers that come from the same account.
    const [reconciliations, overview] = await Promise.all([
      listReconciliations(session.businessId, accountCode),
      getAccountOverview(session.businessId, accountCode),
    ]);
    return NextResponse.json({ reconciliations, overview });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
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

  if (!isReconcilableAccount(body.accountCode)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }
  const statementDate = body.statementDate?.trim() ?? "";
  if (!statementDate) {
    return NextResponse.json({ error: "statement_date_required" }, { status: 400 });
  }
  // Validated here rather than left to Postgres: a `date` column handed
  // anything else raises `invalid input syntax for type date`, which reaches
  // the accountant as a 500 and «خطای غیرمنتظره».
  if (!isIsoDate(statementDate)) {
    return NextResponse.json({ error: "invalid_statement_date" }, { status: 400 });
  }
  const statementBalance = Number(body.statementBalance);
  if (!Number.isSafeInteger(statementBalance)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  try {
    const reconciliation = await createReconciliation({
      businessId: session.businessId,
      accountCode: body.accountCode,
      statementDate,
      statementBalance,
      createdBy: session.sub,
    });
    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
