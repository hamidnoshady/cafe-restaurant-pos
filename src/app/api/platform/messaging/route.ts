import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  getPublicMessageConfig,
  listMessageCreditPackages,
  listPlatformMessageTopUpRequests,
  reviewMessageTopUpRequest,
  saveMessageCreditPackage,
  savePlatformMessageConfig,
  type MessageSaveConfigInput,
} from "@/lib/messaging-billing";

/**
 * Phase 37b's platform message console.  It deliberately exposes masked
 * configuration only: credentials can arrive in a PUT body and are encrypted
 * by the service, but they are never serialised back to a browser.
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

/** Save provider/rate configuration, packages, or review a top-up request. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformCapability("billing.manage");
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
      smsRialPerSegment: finiteNonNegativeInteger(body.smsRialPerSegment),
      emailRialPerSend: finiteNonNegativeInteger(body.emailRialPerSend),
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
        smsRialPerSegment: config.rate.smsRialPerSegment,
        emailRialPerSend: config.rate.emailRialPerSend,
      },
    });
    return NextResponse.json({ config });
  }

  if (body.action === "package") {
    const name = typeof body.name === "string" ? body.name : "";
    const priceRial = finiteNonNegativeInteger(body.priceRial);
    const creditAmountRial = finiteNonNegativeInteger(body.creditAmountRial);
    if (!name.trim() || !priceRial || !creditAmountRial) {
      return NextResponse.json({ error: "invalid_message_credit_package" }, { status: 400 });
    }
    try {
      const pkg = await saveMessageCreditPackage({
        id: typeof body.id === "string" && body.id ? body.id : undefined,
        name,
        priceRial,
        creditAmountRial,
        isActive: body.isActive !== false,
        sortOrder: finiteNonNegativeInteger(body.sortOrder) ?? 0,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        action: "messaging.package.save",
        entity: "message_credit_package",
        entityId: pkg.id,
        payload: { name: pkg.name, isActive: pkg.isActive, priceRial: pkg.priceRial, creditAmountRial: pkg.creditAmountRial },
      });
      return NextResponse.json({ package: pkg });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "package_failed" }, { status: 400 });
    }
  }

  if (body.action === "review_top_up") {
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const status = body.status === "approved" || body.status === "rejected" ? body.status : null;
    if (!requestId || !status) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    try {
      const topUp = await reviewMessageTopUpRequest({ requestId, status, platformAdminId: guard.session.padmin });
      await platformAudit({
        adminId: guard.session.padmin,
        businessId: topUp.businessId,
        action: `messaging.top_up.${status}`,
        entity: "message_top_up_request",
        entityId: topUp.id,
        payload: { creditAmountRial: topUp.creditAmountRial },
      });
      return NextResponse.json({ request: topUp });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "top_up_failed" }, { status: 400 });
    }
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});
