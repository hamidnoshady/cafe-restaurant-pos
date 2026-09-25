import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsWebsiteState } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/state` — is this business's website connected, and
 * which CMS site is it (masked — the browser never sees the key).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const connection = await cmsWebsiteState(session.businessId);
  return NextResponse.json({ connected: Boolean(connection), connection });
});
