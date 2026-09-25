import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsWebsiteDns } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/dns` — the Website Manager's DNS checklist state for
 * the connected site: does the domain resolve to the CMS server (checked
 * from here, server-side) and has the operator verified it in the CMS admin
 * (descriptor `domainVerified`).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const result = await cmsWebsiteDns(session.businessId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "not_connected" ? 404 : 502 });
  }

  const response = NextResponse.json({ status: result.data });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
