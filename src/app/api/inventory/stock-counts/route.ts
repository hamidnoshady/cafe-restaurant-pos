import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createStockCount, type StockCountLineInput } from "@/lib/stock-count-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ counts: [] });

  const { rows: counts } = await query(
    `SELECT sc.id, sc.note, sc.counted_at, u.full_name AS counted_by_name,
            (SELECT count(*) FROM stock_count_lines WHERE stock_count_id = sc.id) AS line_count
       FROM stock_counts sc LEFT JOIN users u ON u.id = sc.counted_by
      WHERE sc.location_id = $1 AND sc.reversal_of IS NULL
      ORDER BY sc.counted_at DESC LIMIT 50`,
    [location.id],
  );
  return NextResponse.json({ counts });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { note?: string; lines?: StockCountLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const lines = body.lines ?? [];
  if (lines.length === 0) return NextResponse.json({ error: "no_items" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      note: body.note,
      lines,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: result.id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      const known = ["no_items", "invalid_item", "item_not_found"];
      if (known.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  } finally {
    client.release();
  }
});
