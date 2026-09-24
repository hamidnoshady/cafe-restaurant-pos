import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getWebsiteSetup, saveWebsiteSetup, type WebsiteSetupPatch } from "@/lib/website/setup-service";
import { listWebsitePlans } from "@/lib/website/billing-service";

/**
 * `GET /api/cms/website/setup` — the site-building wizard's state, plus the
 * plan catalogue the last step chooses from.
 *
 * `PATCH` records one step's answer. It never advances the wizard past what
 * the answers justify: the step is derived from the state in
 * `src/lib/website/setup.ts`, so opening the wizard on another device lands on
 * the same screen without a second source of truth to keep in step.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteView);
  if (error) return error;
  const [setup, plans] = await Promise.all([getWebsiteSetup(session.businessId), listWebsitePlans()]);
  const response = NextResponse.json({ setup, plans });
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteConfigure);
  if (error) return error;

  let body: WebsiteSetupPatch;
  try {
    body = (await request.json()) as WebsiteSetupPatch;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await saveWebsiteSetup(session.businessId, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ setup: result.data });
});
