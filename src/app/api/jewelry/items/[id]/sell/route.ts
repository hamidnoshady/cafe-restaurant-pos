import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem } from "@/lib/items-service";
import { sellWeightedItem } from "@/lib/gold-sales-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import type { MakingChargeType } from "@/lib/gold-pricing";
import type { SettlementMethod } from "@/lib/ledger";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];
const MAKING_CHARGE_TYPES: MakingChargeType[] = ["percent", "fixed"];

/** Sells a specific weighed piece -- owned or consigned, gold-sales-service.ts branches on that itself. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const item = await getItem(id);
  if (!item || item.locationId !== location.id) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  let body: {
    makingChargeType?: string;
    makingChargeValue?: number;
    profitPercent?: number;
    vatPercent?: number;
    paymentMethod?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const makingChargeType = body.makingChargeType as MakingChargeType;
  if (!MAKING_CHARGE_TYPES.includes(makingChargeType)) {
    return NextResponse.json({ error: "invalid_making_charge" }, { status: 400 });
  }
  const makingChargeValue = Number(body.makingChargeValue);
  const profitPercent = Number(body.profitPercent);
  const vatPercent = Number(body.vatPercent);
  if (![makingChargeValue, profitPercent, vatPercent].every(Number.isFinite)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const paymentMethod = body.paymentMethod as SettlementMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await sellWeightedItem(client, {
      businessId: session.businessId,
      locationId: location.id,
      itemId: id,
      makingCharge: { type: makingChargeType, value: makingChargeValue },
      profitPercent,
      vatPercent,
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
