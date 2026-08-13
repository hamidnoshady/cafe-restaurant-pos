import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { payConsignor } from "@/lib/consignment-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";

/** Settles part or all of what a consignor is owed — the "pay" half of Wave 4's invoice-then-pay shape. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { amount?: number; paymentMethod?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const paymentMethod = body.paymentMethod === "bank" ? "bank" : "cash";

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await payConsignor(client, {
      businessId: session.businessId,
      locationId: location.id,
      consignorId: id,
      amount: Number(body.amount),
      paymentMethod,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
