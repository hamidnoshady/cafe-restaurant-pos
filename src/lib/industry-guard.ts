/**
 * Phase 21 — gating a page or API route to one `businesses.industry`, the
 * same shape as `features.ts`'s `requireFeatureForPage`/`featureForApiPath`
 * pair but keyed on the immutable industry a business chose at creation
 * (industries.ts) rather than a togglable feature flag.
 *
 * The jewelry dashboard page and its `/api/jewelry/*` routes are the first
 * consumers: both need "is this business actually a jewelry business" re-checked
 * live on every request, not trusted from the session token (which doesn't
 * carry industry at all).
 */
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { SessionPayload } from "./auth";
import { query } from "./db";
import type { Industry } from "./industries";
import { hasModule, type ModuleKey } from "./industry-profile";

export async function getBusinessIndustry(businessId: string): Promise<Industry | null> {
  const { rows } = await query<{ industry: Industry }>(
    "SELECT industry FROM businesses WHERE id = $1",
    [businessId],
  );
  return rows[0]?.industry ?? null;
}

/** Called from a gated dashboard page's server component; redirects away if this business isn't the required industry. */
export async function requireIndustryForPage(businessId: string, industry: Industry): Promise<void> {
  if ((await getBusinessIndustry(businessId)) !== industry) redirect("/dashboard");
}

/** Called from a gated API route handler; returns a 403 response to short-circuit with, or null to continue. */
export async function requireIndustryForApi(
  session: SessionPayload,
  industry: Industry,
): Promise<NextResponse | null> {
  if ((await getBusinessIndustry(session.businessId)) !== industry) {
    return NextResponse.json({ error: "industry_mismatch" }, { status: 403 });
  }
  return null;
}

/**
 * Phase 25 Wave 2 — the module half of the same idea.
 *
 * `requireIndustryForPage`/`ForApi` above ask "is this business exactly this
 * industry", which is right for a page that only one industry has. These ask
 * the broader question the shell needs — "does this industry have this area at
 * all" — using `industry-profile.ts`'s module sets, so an F&B-only route
 * refuses a jewellery business without needing an `industry` named at every
 * call site.
 *
 * Enforced at the API guard (`withTenantScope`, auth.ts) rather than only in
 * the nav, for the same reason `features.ts` is: hiding a link is decoration
 * if the route still answers.
 */
export async function isModuleEnabled(businessId: string, module: ModuleKey): Promise<boolean> {
  const industry = await getBusinessIndustry(businessId);
  // A business whose row we cannot read is not a business whose modules we can
  // narrow — fail open here and let the ordinary auth/tenancy guards refuse,
  // exactly as `isFeatureEnabled` does for an unknown flag.
  return industry === null || hasModule(industry, module);
}

/** Called from a gated dashboard page's server component; redirects away if this industry has no such module. */
export async function requireModuleForPage(businessId: string, module: ModuleKey): Promise<void> {
  if (!(await isModuleEnabled(businessId, module))) redirect("/dashboard");
}
