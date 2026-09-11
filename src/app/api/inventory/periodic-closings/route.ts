import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import {
  createPeriodicClosing,
  listPeriodicClosings,
  type PeriodicClosingLineInput,
} from "@/lib/periodic-closing-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * سیستم ادواری — بستن دوره انبار. GET lists posted closings for the active
 * branch; POST counts ending stock, values it under the locked method and
 * posts COGS = اول دوره + خرید − پایان دوره (periodic-closing-service.ts).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ closings: [] });

  const client = await getPool().connect();
  try {
    const closings = await listPeriodicClosings(client, location.id);
    return NextResponse.json({ closings });
  } finally {
    client.release();
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { periodEnd?: string; note?: string; lines?: PeriodicClosingLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const lines = body.lines ?? [];
  if (!body.periodEnd) return NextResponse.json({ error: "invalid_period_end" }, { status: 400 });
  if (lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createPeriodicClosing(client, {
      businessId: session.businessId,
      locationId: location.id,
      periodEnd: body.periodEnd,
      note: body.note,
      lines,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      const status: Record<string, number> = {
        invalid_period_end: 400,
        no_items: 400,
        invalid_item: 400,
        item_not_found: 400,
        not_periodic_system: 409,
        period_end_not_after_previous: 409,
      };
      if (err.message in status) return NextResponse.json({ error: err.message }, { status: status[err.message] });
      if (err.message.startsWith("count_line_missing")) {
        return NextResponse.json({ error: "count_line_missing" }, { status: 400 });
      }
    }
    throw err;
  } finally {
    client.release();
  }
});
