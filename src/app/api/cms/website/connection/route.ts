import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { disconnectCmsWebsite } from "@/lib/cms/website-service";

/**
 * `DELETE /api/cms/website/connection` — disconnect the business's website.
 * The CMS site and its content stay; only this app's stored key is removed.
 */
export const DELETE = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteConfigure);
  if (error) return error;

  await disconnectCmsWebsite(session.businessId);
  return NextResponse.json({ connected: false });
});
