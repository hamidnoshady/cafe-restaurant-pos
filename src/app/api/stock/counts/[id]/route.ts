import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getItemStockCountDetail } from "@/lib/item-stock-count-service";

/** One count's lines, for the detail view. */
export const GET = withTenantScope(
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
    if (error) return error;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const { id } = await context.params;
    const client = await getPool().connect();
    try {
      const detail = await getItemStockCountDetail(client, { locationId: location.id, countId: id });
      if (!detail) return NextResponse.json({ error: "count_not_found" }, { status: 404 });
      return NextResponse.json({ count: detail });
    } finally {
      client.release();
    }
  },
);
