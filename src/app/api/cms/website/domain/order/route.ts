import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { purchaseWebsiteDomain, type DomainPurchaseInput } from "@/lib/website/domain-service";

/**
 * `POST /api/cms/website/domain/order` — buy (or transfer, or renew) a domain
 * for the connected site.
 *
 * The registrar order is the CMS's; the money is this app's. Owner only: it
 * spends the business's platform credit and puts the business's name on a
 * registration.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  let body: DomainPurchaseInput;
  try {
    body = (await request.json()) as DomainPurchaseInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await purchaseWebsiteDomain(session.businessId, body, { userId: session.sub });
  if (!result.ok) {
    const status =
      result.error === "insufficient_credit"
        ? 402
        : result.error === "cms_unreachable"
          ? 502
          : result.error === "not_connected"
            ? 409
            : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ order: result.data }, { status: 201 });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
