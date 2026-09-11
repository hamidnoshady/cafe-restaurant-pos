import { NextRequest, NextResponse } from "next/server";

import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { issueSiteApiKey, listSiteApiKeys, revokeSiteApiKey } from "@/lib/cms/client";
import { resolvePlatformCmsConfig } from "@/lib/cms/platform-control-service";
import { cmsErrorCode } from "@/lib/cms/platform-sync";

/**
 * «سایت‌ساز ← کلیدها» — the credential lifecycle of the website platform.
 *
 * Issuing and revoking a site's API key was a `curl` against the CMS or a session
 * in its own admin; it is now a console action with an audit row, which is the
 * whole point of moving the operator's work here.
 *
 * Three rules the shape of this route follows:
 *
 *  - **The raw key is returned exactly once**, in the POST response, because that
 *    is all the CMS will ever give (it stores only a sha256 hash). It is never in
 *    the audit payload, never logged, and the console says so beside it.
 *  - **The list is masked by the CMS itself** (`GET /api/api-keys/list` returns
 *    summaries), so this route does not have to be careful — there is nothing
 *    sensitive to be careless with.
 *  - **Reading the list needs only a platform-admin session**; issuing and revoking
 *    need `cms.manage`. Knowing that a site has three keys, one of them revoked, is
 *    support's business; minting a fourth is not.
 *
 * Issuing a `role: "platform"` key from here is refused. A platform key administers
 * every customer's site on the deployment, and the one this console already holds
 * is how it does that — minting another from inside the surface it authorizes would
 * be a credential nobody accounted for. That stays a deliberate act on the CMS.
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const config = await resolvePlatformCmsConfig();
  if (!config) return NextResponse.json({ error: "cms_not_configured" }, { status: 400 });

  const siteId = request.nextUrl.searchParams.get("siteId") ?? undefined;
  try {
    const { docs } = await listSiteApiKeys(config, { siteId });
    return NextResponse.json({ keys: docs });
  } catch (err) {
    return NextResponse.json({ error: cmsErrorCode(err) }, { status: 502 });
  }
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;

  const config = await resolvePlatformCmsConfig();
  if (!config) return NextResponse.json({ error: "cms_not_configured" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!siteId) return NextResponse.json({ error: "site_required" }, { status: 400 });
  if (!name || name.length > 120) return NextResponse.json({ error: "invalid_name" }, { status: 400 });

  try {
    const issued = await issueSiteApiKey(config, { name, role: "site", siteId });
    await platformAudit({
      action: "platform_cms.key.issue",
      adminId: session.padmin,
      entity: "cms_api_keys",
      entityId: siteId,
      ipAddress: clientIpFrom(request.headers, 0),
      // What was issued and for which site — never the key.
      payload: { name, role: "site", siteId },
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ key: issued }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: cmsErrorCode(err) }, { status: 502 });
  }
});

export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;

  const config = await resolvePlatformCmsConfig();
  if (!config) return NextResponse.json({ error: "cms_not_configured" }, { status: 400 });

  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    await revokeSiteApiKey(config, id);
    await platformAudit({
      action: "platform_cms.key.revoke",
      adminId: session.padmin,
      entity: "cms_api_keys",
      entityId: id,
      ipAddress: clientIpFrom(request.headers, 0),
      payload: { id },
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: cmsErrorCode(err) }, { status: 502 });
  }
});
