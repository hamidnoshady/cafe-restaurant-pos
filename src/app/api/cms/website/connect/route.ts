import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { connectCmsWebsite, type WebsiteConnectInput } from "@/lib/cms/website-service";

/**
 * `POST /api/cms/website/connect` — attach an existing CMS site: probes the
 * descriptor with the pasted credentials, then stores the key encrypted
 * under the business (migration 0122). Re-connecting overwrites the stored
 * key — rotation without a migration.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  let body: Partial<WebsiteConnectInput>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await connectCmsWebsite(session.businessId, {
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
    siteDomain: typeof body.siteDomain === "string" ? body.siteDomain : "",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    keyName: typeof body.keyName === "string" ? body.keyName : undefined,
  });

  if (!result.ok) {
    const status = result.error === "forbidden" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const response = NextResponse.json({ connected: true, site: result.data.site, connection: result.data.connection });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
