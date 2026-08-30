import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { cmsWebsiteState } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/state` — is this business's website connected, and
 * which CMS site is it (masked — the browser never sees the key).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const connection = await cmsWebsiteState(session.businessId);
  return NextResponse.json({ connected: Boolean(connection), connection });
});
