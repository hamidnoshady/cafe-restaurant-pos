import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { cmsPurgeCdn } from "@/lib/cms/website-service";

/** `POST /api/cms/website/cdn/purge` — empty this site's edge cache, nothing else. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  let urls: string[] | undefined;
  try {
    const body = (await request.json()) as { urls?: unknown };
    if (Array.isArray(body.urls) && body.urls.every((url) => typeof url === "string")) {
      urls = body.urls as string[];
    }
  } catch {
    // An empty body means "purge everything", which is the common case.
  }

  const result = await cmsPurgeCdn(session.businessId, urls);
  if (!result.ok) {
    const status = result.error === "not_connected" ? 409 : result.error === "cms_unreachable" ? 502 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
});
