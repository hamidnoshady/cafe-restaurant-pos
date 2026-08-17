import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listMenuCostDrift } from "@/lib/pricing-service";

/** Menu items whose ingredient cost rose past the business's drift threshold since they were priced. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ items: [] });

  const items = await listMenuCostDrift(session.businessId, location.id);
  return NextResponse.json({ items });
});
