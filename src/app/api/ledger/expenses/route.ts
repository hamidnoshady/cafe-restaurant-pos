import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ExpenseError, listExpenses, recordExpense } from "@/lib/expense-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const expenses = await listExpenses(session.businessId);
  return NextResponse.json({ expenses });
});

/** Records a paid operating expense and posts it immediately (Debit the chosen expense account / Credit the payment account). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  let body: {
    accountId?: string;
    paymentAccountId?: string;
    amount?: number;
    expenseDate?: string;
    vendor?: string;
    memo?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const expense = await recordExpense({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      accountId: String(body.accountId ?? ""),
      paymentAccountId: String(body.paymentAccountId ?? ""),
      amount: Number(body.amount),
      expenseDate: body.expenseDate,
      vendor: body.vendor,
      memo: String(body.memo ?? ""),
      createdBy: session.sub,
    });
    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    if (err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
