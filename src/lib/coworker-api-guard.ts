/**
 * Phase 32 — the entitlement check for the coworker's public-API surface.
 *
 * `/api/v1` is gated on `api_platform` alone (see withApiKeyScope), and
 * `features.ts`'s API prefix table only covers the session realm's `/api/ai`.
 * So without this, a business with an API key but no AI entitlement could
 * drive the coworker from a sub app — the exact hole `featureLocked` closes on
 * the dashboard side. The scope says what a key MAY do; this says whether the
 * business has the feature at all.
 */
import { NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";

export async function requireCoworkerFeature(businessId: string): Promise<NextResponse | null> {
  if (await isFeatureEnabled(businessId, "ai_assistant")) return null;
  return NextResponse.json({ error: "feature_disabled", feature: "ai_assistant" }, { status: 403 });
}
