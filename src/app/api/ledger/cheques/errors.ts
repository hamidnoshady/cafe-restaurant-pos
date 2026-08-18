import { NextResponse } from "next/server";
import { ChequeError } from "@/lib/cheques-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/** The three failure shapes every cheque route shares — a bad request, a missing account, a locked period. */
export function chequeErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChequeError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  // A duplicate serial or صیاد id is a data-entry mistake, not a server fault —
  // the same cheque entered twice is exactly what the unique constraints exist
  // to catch.
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
    return NextResponse.json({ error: "duplicate_cheque" }, { status: 409 });
  }
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
  throw err;
}
