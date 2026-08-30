import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { provisionCmsWebsite, type WebsiteProvisionInput } from "@/lib/cms/website-service";

/**
 * `POST /api/cms/website/provision` — create the business's website on the
 * CMS (site + starter content + editor accounts) with the operator's
 * platform key, issue its site key and store it — all in one action, so the
 * business is connected when the form returns. Owner/manager with a
 * platform key configured (`ESHOBE_CMS_URL` + `ESHOBE_CMS_PLATFORM_API_KEY`).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: Partial<WebsiteProvisionInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await provisionCmsWebsite(session.businessId, {
    name: typeof body.name === "string" ? body.name : "",
    domain: typeof body.domain === "string" ? body.domain : "",
    type: body.type === "business" || body.type === "portfolio" || body.type === "store" ? body.type : "business",
  });

  if (!result.ok) {
    const status = result.error === "cms_not_configured" ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const response = NextResponse.json({ connected: true, site: result.data.site, connection: result.data.connection }, { status: 201 });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
