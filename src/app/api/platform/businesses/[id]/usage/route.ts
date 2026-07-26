import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { businessUsage, getBusiness } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * A business's usage snapshot: order volume, open orders, active members,
 * branches, menu size, ledger depth, and last activity. Read-only; any admin
 * may see it — it is the "is this business live or dormant?" panel.
 */
export async function GET(_request: NextRequest, ctx: Ctx) {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ usage: await businessUsage(id) });
}
