import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createItemStockCount,
  listItemStockCounts,
  type ItemStockCountLineInput,
} from "@/lib/item-stock-count-service";

/** Recent physical counts at this branch. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ counts: [] });

  const client = await getPool().connect();
  try {
    return NextResponse.json({ counts: await listItemStockCounts(client, location.id) });
  } finally {
    client.release();
  }
});

/**
 * Record a physical count. The counted quantities become the stock on hand and
 * the difference posts as a variance — one entry for the whole count, shortage
 * and surplus kept apart.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { note?: string; lines?: ItemStockCountLineInput[] };
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
    const result = await createItemStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
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
      const known = [
        "no_items",
        "invalid_item",
        "invalid_quantity",
        "quantity_precision_exceeded",
        "duplicate_item",
        "item_not_found",
      ];
      if (known.includes(err.message)) return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  } finally {
    client.release();
  }
});
