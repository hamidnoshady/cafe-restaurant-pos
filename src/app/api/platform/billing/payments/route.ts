import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listPayments, type PaymentStatus } from "@/lib/wallet-service";

/**
 * All payments across businesses (top-ups, plan/addon purchases), optionally
 * filtered by status — the super-admin's payments ledger.
 */
export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") as PaymentStatus | null) ?? undefined;
  const payments = await listPayments({ status, limit: 200 });
  return NextResponse.json({ payments });
});
