import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { positiveQuantityText, rialText } from "@/lib/inventory-exact";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { listRuns, ProductionError, recordProductionRun } from "@/lib/production-service";
import { resolveActiveLocation } from "@/lib/setup-state";
// Side-effect import: registers the six `production.*` rules with the posting
// engine before any domain event is emitted, the same way the waste route
// imports fnb-posting-rules.
import "@/lib/production-posting-rules";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ runs: [] });

  return NextResponse.json({ runs: await listRuns(location.id) });
});

/**
 * Records one batch: consumes the formula's inputs at their exact cost and
 * receipts the output at what they came to plus the conversion cost. Stock and
 * ledger move together in one transaction, as every other inventory posting
 * path does.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: {
    formulaId?: string;
    batches?: number | string;
    outputQuantity?: number | string | null;
    conversionCostRial?: number | string | null;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.formulaId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  let batches;
  try {
    batches = positiveQuantityText(String(body.batches ?? "1"));
  } catch {
    return NextResponse.json({ error: "invalid_batches" }, { status: 400 });
  }

  // Omitted means "the formula's expected yield"; sent means the tray actually
  // came out at this, which is what the cost gets spread over.
  let outputQuantity = null;
  if (body.outputQuantity !== undefined && body.outputQuantity !== null && String(body.outputQuantity) !== "") {
    try {
      outputQuantity = positiveQuantityText(String(body.outputQuantity));
    } catch {
      return NextResponse.json({ error: "invalid_yield" }, { status: 400 });
    }
  }

  let conversionCostRial = null;
  if (
    body.conversionCostRial !== undefined &&
    body.conversionCostRial !== null &&
    String(body.conversionCostRial) !== ""
  ) {
    try {
      conversionCostRial = rialText(String(body.conversionCostRial));
    } catch {
      return NextResponse.json({ error: "invalid_conversion_cost" }, { status: 400 });
    }
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const run = await recordProductionRun(client, {
      businessId: session.businessId,
      locationId: location.id,
      formulaId: body.formulaId,
      batches,
      outputQuantity,
      conversionCostRial,
      note: body.note?.trim() || null,
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...run });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof ProductionError) {
      return NextResponse.json({ error: err.code }, { status: err.code === "formula_not_found" ? 404 : 409 });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
});
