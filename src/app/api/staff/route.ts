import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

/** Active waiters at this location — for section assignment on the floor plan. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ waiters: [] });

  const { rows: waiters } = await query(
    `SELECT id, full_name FROM users
      WHERE business_id = $1 AND role = 'waiter' AND is_active
        AND (location_id IS NULL OR location_id = $2)
      ORDER BY full_name`,
    [session.businessId, location.id],
  );
  return NextResponse.json({ waiters });
});
