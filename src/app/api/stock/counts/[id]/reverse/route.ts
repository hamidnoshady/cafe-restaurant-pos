import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { reverseItemStockCount } from "@/lib/item-stock-count-service";

/**
 * Undo a posted count. A count is a source document with a ledger effect, so it
 * is corrected by reversal rather than edited — record a fresh count afterwards
 * if the shelf still needs a correct figure.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: { note?: string } = {};
    try {
      body = await request.json();
    } catch {
      // A reversal needs no body; an absent one is not an error.
    }

    const { id } = await context.params;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await reverseItemStockCount(client, {
        businessId: session.businessId,
        locationId: location.id,
        countId: id,
        createdBy: session.sub,
        note: body.note ?? null,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof MissingLedgerAccountError) {
        return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
      }
      if (err instanceof Error) {
        const known = ["count_not_found", "count_not_reversible", "already_reversed", "count_stock_consumed"];
        if (known.includes(err.message)) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
