import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listCheques, recordCheque } from "@/lib/cheques-service";
import { CHEQUE_DIRECTIONS, type ChequeDirection } from "@/lib/cheques";
import { chequeErrorResponse } from "./errors";

/** The cheque register. Same access as the rest of the ledger's subledgers. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const raw = new URL(request.url).searchParams.get("direction");
  if (raw && !CHEQUE_DIRECTIONS.includes(raw as ChequeDirection)) {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }

  const cheques = await listCheques(session.businessId, (raw as ChequeDirection) || undefined);
  return NextResponse.json({ cheques });
});

interface ChequeBody {
  direction?: string;
  serialNumber?: string;
  sayadId?: string;
  bankName?: string;
  accountNumber?: string;
  amount?: number;
  issueDate?: string;
  dueDate?: string;
  counterpartyName?: string;
  customerId?: string;
  supplierId?: string;
  memo?: string;
}

function isChequeBody(value: unknown): value is ChequeBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Records a cheque taken from a customer or written to a supplier, and posts
 * the entry that puts it on the books.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeChequesManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isChequeBody(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const direction = body.direction as ChequeDirection;
  if (!CHEQUE_DIRECTIONS.includes(direction)) {
    return NextResponse.json({ error: "invalid_direction" }, { status: 400 });
  }
  const amount = Number(body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const cheque = await recordCheque({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      direction,
      serialNumber: body.serialNumber ?? "",
      sayadId: body.sayadId ?? null,
      bankName: body.bankName ?? "",
      accountNumber: body.accountNumber ?? null,
      amount,
      issueDate: body.issueDate ?? null,
      dueDate: body.dueDate ?? "",
      counterpartyName: body.counterpartyName ?? "",
      customerId: body.customerId ?? null,
      supplierId: body.supplierId ?? null,
      memo: body.memo ?? null,
      createdBy: session.sub,
    });
    return NextResponse.json({ cheque }, { status: 201 });
  } catch (err) {
    return chequeErrorResponse(err);
  }
});
