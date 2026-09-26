import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { readCommercialSettings, saveCommercialSettings } from "@/lib/billing/runtime";

export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  return NextResponse.json({ settings: await readCommercialSettings() });
});

export const PUT = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await saveCommercialSettings({
    invoicePrefix: typeof body.invoicePrefix === "string" ? body.invoicePrefix : undefined,
    defaultDueDays: numberOrUndefined(body.defaultDueDays),
    defaultGraceDays: numberOrUndefined(body.defaultGraceDays),
    rounding: body.rounding === "ceil" || body.rounding === "floor" ? body.rounding : undefined,
    minimumTopUpRial: numberOrUndefined(body.minimumTopUpRial),
    overagePolicy: body.overagePolicy === "charge" || body.overagePolicy === "block" ? body.overagePolicy : undefined,
    prorationPolicy: body.prorationPolicy === "none" || body.prorationPolicy === "daily" ? body.prorationPolicy : undefined,
    defaultSpendAction: typeof body.defaultSpendAction === "string" ? body.defaultSpendAction : undefined,
    invoiceFooter: typeof body.invoiceFooter === "string" ? body.invoiceFooter : undefined,
    taxRateBps: numberOrUndefined(body.taxRateBps),
  });
  return NextResponse.json({ settings: await readCommercialSettings() });
});

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
