import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItem, getSerial } from "@/lib/items-service";
import { sellSerializedUnit } from "@/lib/watch-sales-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import type { SettlementMethod } from "@/lib/ledger";

const PAYMENT_METHODS: SettlementMethod[] = ["cash", "bank", "credit"];

/** Sells one physical unit: posts revenue + COGS and opens the warranty window, all in one transaction. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const serial = await getSerial(id);
  const item = serial ? await getItem(serial.itemId) : null;
  if (!serial || !item || item.locationId !== location.id) {
    return NextResponse.json({ error: "serial_not_found" }, { status: 404 });
  }

  let body: {
    price?: number;
    discount?: number;
    vatPercent?: number;
    paymentMethod?: string;
    warrantyMonths?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const price = Number(body.price);
  const discount = Number(body.discount ?? 0);
  const vatPercent = Number(body.vatPercent);
  if (![price, discount, vatPercent].every(Number.isFinite)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const paymentMethod = body.paymentMethod as SettlementMethod;
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return NextResponse.json({ error: "invalid_payment_method" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await sellSerializedUnit(client, {
      businessId: session.businessId,
      locationId: location.id,
      serialId: id,
      price,
      discount,
      vatPercent,
      paymentMethod,
      warrantyMonths: body.warrantyMonths,
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
