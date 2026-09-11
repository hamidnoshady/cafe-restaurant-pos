import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Phase 42b — the lots (`item_batches`) of one item at one branch, for the
 * issue form's per-line lot select: a حواله line relieves a named lot at that
 * lot's own cost, so the picker needs the lot numbers with their quantity,
 * cost and expiry. `?item=` is required; `?branch=` (or `locationId`) targets
 * the warehouse and defaults to the session's active location.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const url = new URL(request.url);
  const itemId = url.searchParams.get("item") ?? url.searchParams.get("itemId") ?? "";
  if (!itemId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const defaultLocation = await resolveActiveLocation(session);
  const locationId =
    url.searchParams.get("branch") || url.searchParams.get("locationId") || defaultLocation?.id || "";
  if (!locationId) return NextResponse.json({ batches: [] });

  const { rows } = await query<{
    id: string;
    batch_number: string;
    expiry_date: string | null;
    quantity: string;
    unit_cost: string | null;
  }>(
    `SELECT b.id, b.batch_number, b.expiry_date::text AS expiry_date,
            b.quantity::text AS quantity, b.unit_cost::text
       FROM item_batches b
       JOIN items i ON i.id = b.item_id
      WHERE b.item_id = $1 AND i.location_id = $2
      ORDER BY b.expiry_date NULLS LAST, b.batch_number`,
    [itemId, locationId],
  );

  return NextResponse.json({
    batches: rows.map((r) => ({
      id: r.id,
      batchNumber: r.batch_number,
      expiryDate: r.expiry_date,
      quantity: r.quantity,
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    })),
  });
});
