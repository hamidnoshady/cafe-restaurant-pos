import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildWebsite } from "@/lib/website/setup-service";

/**
 * `POST /api/cms/website/setup/build` — step ۴ of «ساخت سایت»: create the
 * site on the CMS, issue and store its key, and start the chosen plan's
 * subscription.
 *
 * The wizard has always called this address; the route itself was missing, so
 * «ساخت سایت» answered Next's HTML 404 and the screen showed the generic
 * «خطای غیرمنتظره» with no site built. The whole transaction — provision,
 * key, subscription, and the order they must happen in — belongs to
 * `buildWebsite`, so this handler is only the HTTP shell around it.
 *
 * Gated on `website.configure` — the capability for standing a site up and
 * changing what it is — rather than on a role. It spends the business's
 * platform credit and puts a public site on the internet, so it is the
 * strongest of the four website keys rather than plain `website.manage`.
 */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  const result = await buildWebsite(session.businessId);
  if (!result.ok) {
    // `not_ready` and `already_connected` are the caller's state, not a
    // server fault; `cms_not_configured`/`cms_unreachable` are ours, and the
    // UI says so in different words.
    const status =
      result.error === "already_connected"
        ? 409
        : result.error === "cms_not_configured"
          ? 503
          : result.error === "cms_unreachable"
            ? 502
            : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  const response = NextResponse.json(
    { setup: result.data.setup, domain: result.data.domain },
    { status: 201 },
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
