import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsSiteCdn } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/cdn` — the connected site's CDN zone, as the CMS
 * observes it: provider, zone, nameservers and the records the owner must set
 * at their registrar.
 *
 * Read-only by design. Creating or syncing a zone changes live DNS and WAF
 * state at the provider and stays platform-staff work behind a superadmin
 * session on the CMS — a business sees its own zone and can empty its own
 * cache, which is the part that is safely theirs.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;
  const result = await cmsSiteCdn(session.businessId);
  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "cms_unreachable" ? 502 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ cdn: result.data });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
