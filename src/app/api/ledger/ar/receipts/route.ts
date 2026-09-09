import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ArError, MissingLedgerAccountError, receivePayment } from "@/lib/ar-service";
import { listReceipts } from "@/lib/installments-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/** The «دریافت‌ها» ledger slice — every receipt voucher, newest first. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;
  const q = request.nextUrl.searchParams.get("q") ?? undefined;
  const receipts = await listReceipts(session.businessId, q);
  return NextResponse.json({ receipts });
});

interface ReceiptBody {
  customerId?: string;
  method?: string;
  amount?: number;
  receiptDate?: string;
  memo?: string;
}

const METHODS = ["cash", "bank"] as const;

/** Records a customer paying down their AR balance. Same access as posting a manual journal entry. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  let body: ReceiptBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const customerId = body.customerId?.trim();
  if (!customerId) return NextResponse.json({ error: "customer_required" }, { status: 400 });
  if (!METHODS.includes(body.method as (typeof METHODS)[number])) {
    return NextResponse.json({ error: "invalid_method" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const receipt = await receivePayment({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      customerId,
      method: body.method as "cash" | "bank",
      amount,
      receiptDate: body.receiptDate?.trim() || null,
      memo: body.memo,
      createdBy: session.sub,
    });
    return NextResponse.json({ receipt }, { status: 201 });
  } catch (err) {
    if (err instanceof ArError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
