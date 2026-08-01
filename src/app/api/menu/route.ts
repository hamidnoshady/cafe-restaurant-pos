import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getMenuTree } from "@/lib/menu-service";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Full menu tree for the cashier POS grid and the menu management screen:
 * categories → items → attached modifier groups → modifiers.
 * Any authenticated role may read it (cashier needs it to sell).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ categories: [], items: [], modifierGroups: [], modifiers: [] });
  }

  return NextResponse.json(await getMenuTree(location.id));
});
