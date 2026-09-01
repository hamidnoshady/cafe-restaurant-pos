import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { deleteCreditPackage } from "@/lib/wallet-service";

/** Remove a credit package. Existing payments keep their snapshot data. */
export const DELETE = withPlatformScope(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("billing.manage");
    if (guard.error) return guard.error;
    const { id } = await ctx.params;
    await deleteCreditPackage(id);
    return NextResponse.json({ ok: true });
  },
);
