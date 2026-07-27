import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSetting, SETTING_KEYS } from "@/lib/settings";

/** Business/location name + contact info for the printed receipt header — every role that can check out an order needs it, not just managers (unlike /api/setup/business). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const [{ rows }, location, profile] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [session.businessId]),
    resolveActiveLocation(session),
    getSetting<{ receiptFooter?: string }>(session.businessId, SETTING_KEYS.businessProfile),
  ]);

  return NextResponse.json({
    name: rows[0]?.name ?? "",
    address: location?.address ?? null,
    phone: location?.phone ?? null,
    receiptFooter: profile?.receiptFooter ?? null,
  });
});
