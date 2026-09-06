import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { getCustomer } from "@/lib/parties-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { issueStoreCredit, storeCreditBalance, useStoreCredit } from "@/lib/loyalty-service";
import type { SettlementMethod } from "@/lib/ledger";

/** Issues store credit to, or spends a customer's credit (cash/bank payout). */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { action?: "issue" | "use"; amount?: number; paymentMethod?: string; reason?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let balance: number;
    if (body.action === "use") {
      const paymentMethod = (body.paymentMethod === "bank" ? "bank" : "cash") as Extract<
        SettlementMethod,
        "cash" | "bank"
      >;
      const result = await useStoreCredit(client, {
        businessId: session.businessId,
        locationId: location.id,
        customerId: id,
        amount: Number(body.amount),
        paymentMethod,
        createdBy: session.sub,
      });
      balance = result.balance;
    } else {
      await issueStoreCredit(client, {
        businessId: session.businessId,
        locationId: location.id,
        customerId: id,
        amount: Number(body.amount),
        reason: body.reason,
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
