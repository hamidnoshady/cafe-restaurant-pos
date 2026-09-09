import { NextRequest, NextResponse } from "next/server";

import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { parseCmsConfigPatch } from "@/lib/cms/platform-control";
import {
  getCmsControlConfig,
  recordCmsVerification,
  resolvePlatformCmsConfig,
  saveCmsControlConfig,
} from "@/lib/cms/platform-control-service";
import { verifyCmsConnection } from "@/lib/cms/platform-client";

/**
 * «سایت‌ساز ← اتصال» — the CMS's address and its platform credential
 * (migration 0139).
 *
 * Readable by any platform admin, because the *state* of the website platform's
 * connection is what a support operator needs when a customer says their site is
 * down: is it configured, was it last verified, is the mirror running. The read is
 * masked by `getCmsControlConfig`, which returns the last four characters of the
 * key and nothing else — the credential itself is never returned by anything, the
 * same three-layer discipline the CMS keeps for its own gateway secrets.
 *
 * Writes need `cms.manage`. The credential rule is the one to keep in mind: an
 * omitted or empty `apiKey` means *unchanged*, because the form renders masked and
 * therefore posts it empty on every save. `clearApiKey: true` is the explicit door.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ config: await getCmsControlConfig() });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const before = await getCmsControlConfig();
  const parsed = parseCmsConfigPatch((body ?? {}) as Record<string, unknown>, {
    allowInsecure: before.allowInsecure,
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.errors[0], errors: parsed.errors }, { status: 400 });
  }

  const config = await saveCmsControlConfig(parsed.changes, session.padmin);

  await platformAudit({
    action: "platform_cms.config.update",
    adminId: session.padmin,
    entity: "platform_cms_config",
    ipAddress: clientIpFrom(request.headers, 0),
    payload: {
      allowInsecure: config.allowInsecure,
      baseUrl: config.baseUrl,
      logShippingEnabled: config.logShippingEnabled,
      mirrorEnabled: config.mirrorEnabled,
      mirrorIntervalMinutes: config.mirrorIntervalMinutes,
      // Which credential moved, never what it was — and the hint, so an audit
      // reader can tell one rotation from the next.
      credentialChanged: Boolean(parsed.changes.apiKey) || Boolean(parsed.changes.clearApiKey),
      credentialCleared: Boolean(parsed.changes.clearApiKey),
      keyHint: config.apiKeyHint,
    },
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ config });
});

/**
 * `POST` verifies the stored address + key against the CMS itself.
 *
 * Separate from the save on purpose: an operator pasting a key needs to know
 * whether it works, and a save that silently succeeded while the credential was
 * wrong is the state this whole section exists to make visible. The result is
 * stamped onto the row (`verified_at` / `verify_error`) so the answer survives the
 * page being closed, and the classified `reason` is what the console turns into
 * Persian — «۴۰۳» is not an instruction.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;

  const config = await resolvePlatformCmsConfig();
  if (!config) return NextResponse.json({ error: "cms_not_configured" }, { status: 400 });

  const result = await verifyCmsConnection(config, { actor: session.padmin });
  await recordCmsVerification({ error: result.error ?? null, ok: result.ok });

  await platformAudit({
    action: "platform_cms.config.verify",
    adminId: session.padmin,
    entity: "platform_cms_config",
    ipAddress: clientIpFrom(request.headers, 0),
    payload: { ok: result.ok, reason: result.reason ?? null, sites: result.sites ?? null },
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({
    config: await getCmsControlConfig(),
    result: { ok: result.ok, reason: result.reason ?? null, sites: result.sites ?? null },
  });
});
