import { NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getInventoryOverview } from "@/lib/inventory-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Everything the inventory management screen needs in one call. The shared
 * service is also used by the public API, but this tenant route continues to
 * resolve the staff member's active branch first.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({
      items: [],
      suppliers: [],
      menuItems: [],
      modifiers: [],
      recipes: [],
      modifierRecipes: [],
      costingMethod: null,
      inventorySystem: null,
    });
  }

  return NextResponse.json(await getInventoryOverview(location.id, session.businessId));
});
