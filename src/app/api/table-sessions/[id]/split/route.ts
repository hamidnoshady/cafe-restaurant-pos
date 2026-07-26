import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { billToSplitLines, computeSessionBill } from "@/lib/table-session-service";
import { evenSplit, itemizedSplit } from "@/lib/table-sessions";

async function ownOpenSession(locationId: string, id: string): Promise<boolean> {
  const { rows } = await query("SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2", [id, locationId]);
  return rows.length > 0;
}

/** The session's billable lines (for building an itemized split UI). */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownOpenSession(location.id, id))) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const bill = await computeSessionBill(id);
  return NextResponse.json({ bill });
});

interface SplitBody {
  mode?: "even" | "itemized";
  guests?: number;
  /** itemized only: orderItemId → payer index (0-based). Missing/shared → split evenly. */
  assignments?: Record<string, number>;
}

/** Compute separately-payable shares for the session bill. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  if (!(await ownOpenSession(location.id, id))) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  let body: SplitBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const guests = Math.trunc(Number(body.guests));
  if (!Number.isFinite(guests) || guests < 1 || guests > 50) {
    return NextResponse.json({ error: "invalid_guests" }, { status: 400 });
  }

  const bill = await computeSessionBill(id);

  try {
    const shares =
      body.mode === "itemized"
        ? itemizedSplit(billToSplitLines(bill, body.assignments ?? {}), guests)
        : evenSplit(bill.total, guests);
    return NextResponse.json({ total: bill.total, guests, mode: body.mode === "itemized" ? "itemized" : "even", shares });
  } catch {
    return NextResponse.json({ error: "invalid_split" }, { status: 400 });
  }
});
