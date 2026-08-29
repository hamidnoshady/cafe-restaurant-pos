import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import {
  BackdatedOrderError,
  listBackdatedOrders,
  recordBackdatedOrder,
} from "@/lib/backdated-order-service";
import { validateBackdatedOrder, type BackdatedOrderInput } from "@/lib/backdated-orders";
import { invalidateByRange } from "@/lib/ai-answer-cache";
import { getPool, query } from "@/lib/db";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { paymentFailureFor } from "@/lib/order-payment-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Conditions someone can go and fix rather than bugs. `fiscal_period_locked`
 * and `fiscal_period_soft_closed` come from migration 0024's trigger, which
 * fires on the *back-dated* entry date this route posts — so a closed month
 * refuses the sale here instead of letting it slide into the current one.
 */
const KNOWN_FAILURES: Record<string, number> = {
  fiscal_period_locked: 409,
  fiscal_period_soft_closed: 409,
};

function failureFor(err: unknown): NextResponse | null {
  if (err instanceof BackdatedOrderError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  const message = err instanceof Error ? err.message : "";
  const status = KNOWN_FAILURES[message];
  if (status) return NextResponse.json({ error: message }, { status });
  // Negative stock, a settled costing layer, a missing cutover: the same
  // family of "go and fix it" faults the checkout route maps.
  const failure = paymentFailureFor(err);
  if (failure) return NextResponse.json({ error: failure.error }, { status: failure.status });
  return null;
}

/** The branch's recent back-dated entries — the panel's list. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersBackdate);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ entries: [] });

  const client = await getPool().connect();
  try {
    return NextResponse.json({ entries: await listBackdatedOrders(client, location.id) });
  } finally {
    client.release();
  }
});

/**
 * Record a sale that already happened — the evening the POS was down, or the
 * trading that predates the install. Creates, settles and posts the order in
 * one transaction, dated when it happened rather than now; see
 * backdated-order-service.ts for which timestamps move and which deliberately
 * do not.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersBackdate);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: BackdatedOrderInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // The day-and-time the screen sends is wall-clock time *at the branch*, so
  // the branch's own zone is what resolves it into an instant — not the
  // browser's, and not the server's. See instantInTimeZone.
  const { rows: branch } = await query<{ timezone: string }>(
    "SELECT timezone FROM locations WHERE id = $1",
    [location.id],
  );
  const validated = validateBackdatedOrder(body, { timeZone: branch[0]?.timezone });
  if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await recordBackdatedOrder(client, {
      businessId: session.businessId,
      locationId: location.id,
      actorId: session.sub,
      input: validated.value,
    });
    await client.query("COMMIT");
    // Phase 36 Wave 7 — a sale typed in late changes the very window a cached
    // answer summarised, so every cached answer whose tool signature covers
    // this entry date is dropped before the route answers. Awaited but
    // self-contained: it runs after COMMIT and never throws, so a committed
    // sale cannot be failed by its own cache maintenance.
    await invalidateByRange(session.businessId, { from: result.entryDate, to: result.entryDate });
    // Deliberately no realtime broadcast: nothing on a live screen — the POS
    // queue, the KDS, the floor — is showing a sale from last Tuesday, and
    // waking them for one would only make a finished order flash past.
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK");
    const failure = failureFor(err);
    if (failure) return failure;
    throw err;
  } finally {
    client.release();
  }
});
