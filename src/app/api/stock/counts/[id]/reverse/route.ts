import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
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
    const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
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
        const statusByError: Record<string, number> = {
          count_not_found: 404,
          count_not_reversible: 409,
          already_reversed: 409,
          count_stock_consumed: 409,
        };
        const status = statusByError[err.message];
        if (status) return NextResponse.json({ error: err.message }, { status });
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
