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
