import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { applyInvoicePayment, voidBillingInvoice, SubscriptionError } from "@/lib/subscription-service";

export const POST = withPlatformScope(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { action?: string; amountRial?: number } | null;
  try {
    if (body?.action === "void") {
      return NextResponse.json({ invoice: await voidBillingInvoice(id) });
    }
    if (body?.action === "payment" && typeof body.amountRial === "number") {
      return NextResponse.json({ invoice: await applyInvoicePayment(id, body.amountRial) });
    }
  } catch (err) {
    if (err instanceof SubscriptionError) {
      return NextResponse.json({ error: err.code }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
