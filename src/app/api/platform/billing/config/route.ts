import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
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
  const guard = await requirePlatformCapability("gateways.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const gateway = body.gateway === "zarinpal" || body.gateway === "manual" ? body.gateway : undefined;
  const before = await getPaymentConfig();
  const config = await savePaymentConfig({
    gateway,
    // Empty string clears the merchant id; absent key keeps it.
    merchantId: typeof body.merchantId === "string" ? body.merchantId : undefined,
    sandbox: typeof body.sandbox === "boolean" ? body.sandbox : undefined,
    callbackUrl: typeof body.callbackUrl === "string" ? body.callbackUrl : undefined,
    currency: body.currency === "IRT" || body.currency === "IRR" ? body.currency : undefined,
    platformAdminId: guard.session.padmin,
  });

  // Audit the delta only — the merchant id itself never lands in the log.
  const changed = (before.gateway !== config.gateway ? "gateway" : 0)
    || (before.sandbox !== config.sandbox ? "sandbox" : 0)
    || (before.callbackUrl !== config.callbackUrl ? "callback_url" : 0)
    || (before.currency !== config.currency ? "currency" : 0)
    || (before.merchantId !== config.merchantId ? "merchant_id" : 0);
  await platformAudit({
    adminId: guard.session.padmin,
    action: "gateway.updated",
    entity: "platform_payment_config",
    entityId: "true",
    payload: {
      changed,
      before: {
        gateway: before.gateway,
        sandbox: before.sandbox,
        callbackUrl: before.callbackUrl,
        currency: before.currency,
        merchantIdSet: Boolean(before.merchantId),
      },
      after: {
        gateway: config.gateway,
        sandbox: config.sandbox,
        callbackUrl: config.callbackUrl,
        currency: config.currency,
        merchantIdSet: Boolean(config.merchantId),
      },
    },
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
