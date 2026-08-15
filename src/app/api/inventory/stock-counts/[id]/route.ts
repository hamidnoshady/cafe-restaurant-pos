import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  editStockCount,
  getStockCountDetail,
  reverseStockCount,
  type StockCountLineInput,
} from "@/lib/stock-count-service";

type Context = { params: Promise<{ id: string }> };

function errorFor(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "";
  const known: Record<string, number> = {
    count_not_found: 404,
    count_not_reversible: 409,
    already_reversed: 409,
    count_layer_settled: 409,
    count_stock_consumed: 409,
    stock_count_reversal_inconsistent: 409,
    no_items: 400,
    invalid_item: 400,
    item_not_found: 404,
  };
  const status = known[message];
  if (status) return NextResponse.json({ error: message }, { status });
  throw err;
}

export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    const detail = await getStockCountDetail(client, {
      businessId: session.businessId,
      locationId: location.id,
      countId: id,
    });
    if (!detail) return NextResponse.json({ error: "count_not_found" }, { status: 404 });
    return NextResponse.json({ count: detail });
  } finally {
    client.release();
  }
});

/** Correct a posted count: reverse it, then re-record the edited lines (if any). */
export const PATCH = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;

  let body: { note?: string; lines?: StockCountLineInput[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await editStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      countId: id,
      note: body.note,
      lines: body.lines ?? [],
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    return errorFor(err);
  } finally {
    client.release();
  }
});

/** Remove a posted count: a full reversal that restores stock and ledger. */
export const DELETE = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseStockCount(client, {
      businessId: session.businessId,
      locationId: location.id,
      countId: id,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id: result.id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    return errorFor(err);
  } finally {
    client.release();
  }
});
