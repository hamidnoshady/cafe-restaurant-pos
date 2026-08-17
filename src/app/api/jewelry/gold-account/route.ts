import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  goldAccountBalance,
  goldAccountStatement,
  recordGoldAccountMovement,
  JewelryFlagshipError,
} from "@/lib/jewelry-flagship-service";

/** One customer's gold-account statement and gram balance. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const customerId = (request.nextUrl.searchParams.get("customerId") ?? "").trim();
  if (!customerId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const [statement, balance] = await Promise.all([
    goldAccountStatement(session.businessId, customerId),
    goldAccountBalance(session.businessId, customerId),
  ]);
  return NextResponse.json({ statement, balanceGrams: balance.toFixed() });
});

/** Records a signed gold-account movement (deposit or withdrawal, in grams). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { customerId?: string; grams?: string; pricePerGram?: number; reason?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.customerId || !body.grams) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const movement = await recordGoldAccountMovement(client, {
      businessId: session.businessId,
      locationId: location.id,
      customerId: body.customerId,
      grams: body.grams,
      pricePerGram: Number(body.pricePerGram ?? 0),
      reason: body.reason ?? null,
      sourceType: "gold_account_manual",
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, movement });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "ثبت گردش حساب طلایی ناموفق بود.";
    return NextResponse.json({ error: "gold_account_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
