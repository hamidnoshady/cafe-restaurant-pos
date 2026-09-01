import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getPaymentConfig, savePaymentConfig } from "@/lib/wallet-service";

/** The payment gateway configuration (merchant id is masked for non-owners). */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const config = await getPaymentConfig();
  return NextResponse.json({
    config: {
      ...config,
      // Never ship the full merchant id to readers; the page only needs to
      // know whether one is set and its last four characters.
      merchantIdSet: Boolean(config.merchantId),
      merchantIdHint: config.merchantId ? `…${config.merchantId.slice(-4)}` : "",
      merchantId: undefined,
    },
  });
});

/** Update gateway config — owner/engineer with billing.manage only. */
export const PUT = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const gateway = body.gateway === "zarinpal" || body.gateway === "manual" ? body.gateway : undefined;
  const config = await savePaymentConfig({
    gateway,
    // Empty string clears the merchant id; absent key keeps it.
    merchantId: typeof body.merchantId === "string" ? body.merchantId : undefined,
    sandbox: typeof body.sandbox === "boolean" ? body.sandbox : undefined,
    callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
    currency: body.currency === "IRT" || body.currency === "IRR" ? body.currency : undefined,
    platformAdminId: guard.session.padmin,
  });

  return NextResponse.json({
    config: {
      ...config,
      merchantIdSet: Boolean(config.merchantId),
      merchantIdHint: config.merchantId ? `…${config.merchantId.slice(-4)}` : "",
      merchantId: undefined,
    },
  });
});
