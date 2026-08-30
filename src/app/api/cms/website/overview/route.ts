import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { cmsWebsiteOverview } from "@/lib/cms/website-service";

/**
 * `GET /api/cms/website/overview` — the connected site in one call:
 * descriptor (theme, locales, store currency) + pages + products + orders.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const result = await cmsWebsiteOverview(session.businessId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === "not_connected" ? 404 : 502 });
  }

  const response = NextResponse.json({ overview: result.data });
  // The CMS controls freshness of its own content; a short shared cache keeps
  // the POS server healthy without serving yesterday's price for long.
  response.headers.set("Cache-Control", "private, s-maxage=30, stale-while-revalidate=300");
  return response;
});
