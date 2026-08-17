import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { ProductionError, reverseProductionRun } from "@/lib/production-service";
import { resolveActiveLocation } from "@/lib/setup-state";
// Side-effect import: registers the six `production.*` rules with the engine.
import "@/lib/production-posting-rules";

/**
 * Undoes a posted run with a reversing document — a posted source document is
 * never mutated in place, the same posture stock counts, write-downs and
 * transfers take.
 *
 * Refused (409) once part of the batch has left: `production_output_consumed`
 * when the till has already sold some of what was made, `consumption_layer_settled`
 * when a later receipt has settled a shortage one of the inputs opened. Both
 * would require re-costing sales that are already posted.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;
    const { id } = await context.params;

    let body: { note?: string } = {};
    try {
      body = await request.json();
    } catch {
      // A reversal needs no body; an absent one is not an error.
    }

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const reversal = await reverseProductionRun(client, {
        businessId: session.businessId,
        locationId: location.id,
        runId: id,
        note: body.note?.trim() || null,
        createdBy: session.sub,
      });
      await client.query("COMMIT");
      return NextResponse.json({ ok: true, id: reversal.id });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof ProductionError) {
        return NextResponse.json({ error: err.code }, { status: err.code === "run_not_found" ? 404 : 409 });
      }
      if (err instanceof Error && err.message === "consumption_layer_settled") {
        return NextResponse.json({ error: "consumption_layer_settled" }, { status: 409 });
      }
      if (err instanceof MissingLedgerAccountError) {
        return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
      }
      throw err;
    } finally {
      client.release();
    }
  },
);
