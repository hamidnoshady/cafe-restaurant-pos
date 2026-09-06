import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { quoteWebsiteDomain } from "@/lib/website/domain-service";

/**
 * `GET /api/cms/website/domain/quote?domain=&operation=&period=` — what a
 * domain costs through the platform's registrar, in Rial, with the business's
 * current wallet balance beside it so the screen can offer a top-up before an
 * order exists rather than after one fails.
 *
 * A quote has no side effects and needs no site, which is why the wizard can
 * price a domain at its very first step.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const params = new URL(request.url).searchParams;
  const result = await quoteWebsiteDomain(session.businessId, {
    domain: params.get("domain") ?? "",
    operation: params.get("operation") ?? "register",
    period: Number(params.get("period") ?? "1"),
  });
  if (!result.ok) {
    const status = result.error === "cms_not_configured" ? 503 : result.error === "cms_unreachable" ? 502 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ quote: result.data });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
