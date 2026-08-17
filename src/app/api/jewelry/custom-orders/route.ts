import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool, query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createCustomOrder, JewelryFlagshipError } from "@/lib/jewelry-flagship-service";

/** This branch's custom-order (سفارش ساخت) tickets. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ tickets: [] });

  const { rows } = await query<{
    id: string;
    ticket_number: string;
    customer_name: string | null;
    item_description: string;
    grams: string;
    status: string;
    promised_date: string | null;
  }>(
    `SELECT t.id, t.ticket_number::text, c.name AS customer_name, t.item_description, t.grams::text, t.status::text, t.promised_date::text
       FROM custom_order_tickets t LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.location_id = $1
      ORDER BY t.ticket_number DESC
      LIMIT 100`,
    [location.id],
  );

  return NextResponse.json({
    tickets: rows.map((r) => ({
      id: r.id,
      ticketNumber: Number(r.ticket_number),
      customerName: r.customer_name,
      itemDescription: r.item_description,
      grams: r.grams,
      status: r.status,
      promisedDate: r.promised_date,
    })),
  });
});

/** Opens a custom-order ticket with a deposit and a promised date. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { customerId?: string | null; itemDescription?: string; grams?: string; depositRial?: number; laborCharge?: number; promisedDate?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.itemDescription?.trim() || !body.grams) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const ticket = await createCustomOrder(client, {
      businessId: session.businessId,
      locationId: location.id,
      customerId: typeof body.customerId === "string" ? body.customerId : null,
      itemDescription: body.itemDescription,
      grams: body.grams,
      depositRial: Number(body.depositRial ?? 0),
      laborCharge: Number(body.laborCharge ?? 0),
      promisedDate: body.promisedDate ?? null,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ticket });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "ثبت سفارش ساخت ناموفق بود.";
    return NextResponse.json({ error: "custom_order_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
