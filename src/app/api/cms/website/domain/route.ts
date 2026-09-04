import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { updateCmsSiteDomain } from "@/lib/cms/website-service";

/**
 * `PATCH /api/cms/website/domain` — move the connected site to a new domain.
 * Resets the CMS's `domainVerified` flag; the DNS checklist must be re-run
 * (and, in production, the new host pointed at the CMS and the box ticked in
 * its admin) before the site serves on it.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { domain?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateCmsSiteDomain(session.businessId, typeof body.domain === "string" ? body.domain : "");

  if (!result.ok) {
    const status =
      result.error === "not_connected" ? 409 :
      result.error === "cms_unreachable" ? 503 :
      result.error === "domain_taken" ? 409 :
      400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ domain: result.data.domain, domainVerified: result.data.domainVerified });
});
