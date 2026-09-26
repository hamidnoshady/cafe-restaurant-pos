import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  getPublicMessageConfig,
  listMessageCreditPackages,
  listPlatformMessageTopUpRequests,
  savePlatformMessageConfig,
  type MessageSaveConfigInput,
} from "@/lib/messaging-billing";

/**
 * Phase 37b's platform message console — now the TECHNICAL half only
 * (migration 0176's ownership split): providers, credentials, sender lines
 * and the master send switch. It deliberately exposes masked configuration
 * only: credentials can arrive in a PUT body and are encrypted by the
 * service, but they are never serialised back to a browser.
 *
 * The commercial half — per-segment/per-send rates, credit packages and the
 * top-up review queue — is managed from `/platform/billing`:
 *   rates    → /api/platform/billing/rates        (action: messaging)
 *   packages → /api/platform/billing/packages     (kind: "messaging")
 *   review   → /api/platform/billing/manual-review
 * This GET still *shows* the packages and pending requests read-only, so the
 * console can render a summary and link to Billing.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [config, packages, requests] = await Promise.all([
    getPublicMessageConfig(),
    listMessageCreditPackages(false),
    listPlatformMessageTopUpRequests(false),
  ]);
  return NextResponse.json({ config, packages, requests });
});

function finiteNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Save the provider/technical configuration. Rate fields are no longer
 * accepted here — they are Billing-owned (single writable path:
 * /api/platform/billing/rates) — so this save preserves the stored rates.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformCapability("messaging.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "config") {
    const input: MessageSaveConfigInput = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      smsProvider: body.smsProvider === "noop" || body.smsProvider === "kavenegar" ? body.smsProvider : undefined,
      emailProvider: body.emailProvider === "noop" || body.emailProvider === "smtp" ? body.emailProvider : undefined,
      kavenegarApiKey: typeof body.kavenegarApiKey === "string" ? body.kavenegarApiKey : undefined,
      kavenegarSender: typeof body.kavenegarSender === "string" ? body.kavenegarSender : undefined,
      clearKavenegarKey: body.clearKavenegarKey === true,
      smtpHost: typeof body.smtpHost === "string" ? body.smtpHost : undefined,
      smtpPort: finiteNonNegativeInteger(body.smtpPort),
      smtpSecure: typeof body.smtpSecure === "boolean" ? body.smtpSecure : undefined,
      smtpUser: typeof body.smtpUser === "string" ? body.smtpUser : undefined,
      smtpPassword: typeof body.smtpPassword === "string" ? body.smtpPassword : undefined,
      smtpFrom: typeof body.smtpFrom === "string" ? body.smtpFrom : undefined,
      clearSmtpPassword: body.clearSmtpPassword === true,
      // Rates are Billing-owned (migration 0176): a value sent here is
      // ignored; the stored rate survives untouched.
      smsRialPerSegment: undefined,
      emailRialPerSend: undefined,
    };
    if (body.smtpPort !== undefined && (input.smtpPort === undefined || input.smtpPort === 0)) {
      return NextResponse.json({ error: "invalid_smtp_port" }, { status: 400 });
    }
    const config = await savePlatformMessageConfig(input);
    await platformAudit({
      adminId: guard.session.padmin,
      action: "messaging.config.save",
      entity: "platform_message_config",
      entityId: "true",
      payload: {
        enabled: config.enabled,
        smsProvider: config.smsProvider,
        emailProvider: config.emailProvider,
      },
    });
    return NextResponse.json({ config });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
