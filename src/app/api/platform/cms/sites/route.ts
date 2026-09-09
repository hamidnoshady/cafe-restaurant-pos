import { NextRequest, NextResponse } from "next/server";

import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { CmsApiError, CmsNetworkError } from "@/lib/cms/client";
import { issueSiteApiKey, provisionSite } from "@/lib/cms/client";
import { listMirroredCmsSites, resolvePlatformCmsConfig } from "@/lib/cms/platform-control-service";
import { cmsErrorCode, runCmsMirror } from "@/lib/cms/platform-sync";

/**
 * «سایت‌ساز ← سایت‌ها» — the fleet's list, and provisioning a new site.
 *
 * `GET` answers from the mirror (`platform_cms_sites`), not from the CMS: the list
 * is what the console's table pages and sorts, a per-site figure over there is
 * several `count` calls, and the mirror is refreshed by the tick and by the
 * «به‌روزرسانی» button. The response says when it was mirrored so the page can be
 * honest about it.
 *
 * `POST` provisions a site on the CMS — the operator's own version of what a
 * business does through its wizard, for the case the wizard cannot cover: an
 * agency-built site, a migration, a replacement after a domain move. It optionally
 * issues that site's key in the same call and returns it **once**, because that is
 * the only moment the CMS will ever show it; the console tells the operator to
 * store it before closing the dialog, and nothing here writes it to a log or the
 * audit payload.
 *
 * A site provisioned here is deliberately *not* connected to a business: that
 * connection carries billing (`website_service_subscriptions`), and creating a
 * subscription for a business nobody named would bill somebody for a site they did
 * not order. The console shows such a site as «بدون کسب‌وکار متصل» — a finding, not
 * an error — and connecting it stays the business's own flow.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ sites: await listMirroredCmsSites() });
});

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const SITE_TYPES = new Set(["business", "portfolio", "store"]);

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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const domain =
    typeof body.domain === "string" ? body.domain.trim().toLowerCase().replace(/\.$/, "") : "";
  const type = typeof body.type === "string" ? body.type : "business";
  const issueKey = body.issueKey === true;

  if (!name || name.length > 120) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  if (!DOMAIN_RE.test(domain)) return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
  if (!SITE_TYPES.has(type)) return NextResponse.json({ error: "invalid_type" }, { status: 400 });

  let site;
  try {
    site = await provisionSite(config, { domain, name, type: type as "business" });
  } catch (err) {
    const code = cmsErrorCode(err);
    return NextResponse.json(
      { error: code },
      { status: err instanceof CmsNetworkError ? 502 : err instanceof CmsApiError ? err.status : 500 },
    );
  }

  let key: null | string = null;
  let keyError: null | string = null;
  if (issueKey) {
    try {
      const issued = await issueSiteApiKey(config, {
        name: `کنسول سکو (${domain})`,
        role: "site",
        siteId: site.site.id,
      });
      key = issued.key;
    } catch (err) {
      // The site exists; the key did not get issued. Reported rather than thrown,
      // because rolling the site back would be worse than an operator pressing
      // «صدور کلید» once more — and the CMS is the one that can re-issue it.
      keyError = cmsErrorCode(err);
    }
  }

  await platformAudit({
    action: "platform_cms.site.provision",
    adminId: session.padmin,
    entity: "platform_cms_sites",
    entityId: site.site.id,
    ipAddress: clientIpFrom(request.headers, 0),
    // The raw key is never in the audit payload; that it was issued is.
    payload: { domain, keyIssued: Boolean(key), keyError, name, type },
    userAgent: request.headers.get("user-agent"),
  });

  // The mirror is refreshed immediately so the new site appears in the table
  // without waiting for the next tick.
  await runCmsMirror({ actor: session.padmin, startedBy: session.padmin, trigger: "manual" });

  return NextResponse.json(
    {
      key,
      keyError,
      site: site.site,
      sites: await listMirroredCmsSites(),
    },
    { status: 201 },
  );
});
