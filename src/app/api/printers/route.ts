import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Operational printer list (Phase 5) — distinct from /api/setup/hardware
 * (manager-only, wizard pairing flow): this is what the POS/waiter/kitchen
 * screens call at checkout / send-to-kitchen time to find a printer's
 * connection info to hand to the local print agent (print-agent/), which is
 * why every role that can trigger a print needs read access to it.
 */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ printers: [] });

  const { rows: printers } = await query(
    `SELECT id, name, kind, connection FROM printers
      WHERE location_id = $1 AND is_active ORDER BY name`,
    [location.id],
  );
  return NextResponse.json({ printers });
}
