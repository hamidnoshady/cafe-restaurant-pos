import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { getCustomer } from "@/lib/parties-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getBusinessDayStatus } from "@/lib/business-day-service";
import { issueStoreCredit, storeCreditBalance, useStoreCredit } from "@/lib/loyalty-service";
import type { SettlementMethod } from "@/lib/ledger";

/** Issues credit for a documented correction, or pays an existing credit balance out. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.loyaltyManage);
  if (error) return error;
  const { id } = await context.params;

  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.action !== "issue" && body.action !== "use") {
    return NextResponse.json({ error: "bad_request", message: "نوع عملیات اعتبار معتبر نیست." }, { status: 400 });
  }
  if (typeof body.amount !== "number") {
    return NextResponse.json({ error: "bad_request", message: "مبلغ اعتبار معتبر نیست." }, { status: 400 });
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
    return NextResponse.json({ error: "bad_request", message: "دلیل اعتبار باید متن باشد." }, { status: 400 });
  }
  if (body.action === "use" && body.paymentMethod !== "cash" && body.paymentMethod !== "bank") {
    return NextResponse.json({ error: "bad_request", message: "روش بازپرداخت باید نقدی یا بانکی باشد." }, { status: 400 });
  }

  const businessDay = await getBusinessDayStatus(location.id);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let balance: number;
    if (body.action === "use") {
      const result = await useStoreCredit(client, {
        businessId: session.businessId,
        locationId: location.id,
        customerId: id,
        amount: body.amount,
        paymentMethod: body.paymentMethod as Extract<SettlementMethod, "cash" | "bank">,
        businessDate: businessDay?.businessDate,
        createdBy: session.sub,
      });
      balance = result.balance;
    } else {
      await issueStoreCredit(client, {
        businessId: session.businessId,
        locationId: location.id,
        customerId: id,
        amount: body.amount,
        reason: (body.reason as string | null | undefined) ?? null,
        businessDate: businessDay?.businessDate,
        createdBy: session.sub,
      });
      balance = await storeCreditBalance(session.businessId, id, client);
    }
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, balance });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "store_credit_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
