import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { giftCardBalance, issueGiftCard } from "@/lib/promotions-service";

/** One card's outstanding value by code. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const code = (request.nextUrl.searchParams.get("code") ?? "").trim();
  if (!code) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  return NextResponse.json({ balance: await giftCardBalance(session.businessId, code) });
});

/** Issues a gift card, posting its value as a liability (2420). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { code?: string; initialValue?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.code?.trim() || !body.initialValue) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await issueGiftCard(client, {
      businessId: session.businessId,
      locationId: location.id,
      code: body.code,
      initialValue: Number(body.initialValue),
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, card: result.card });
  } catch (err) {
    await client.query("ROLLBACK");
    return NextResponse.json({ error: "gift_card_failed", message: (err as Error).message }, { status: 400 });
  } finally {
    client.release();
  }
});
