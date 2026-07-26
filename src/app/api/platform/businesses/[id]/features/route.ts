import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
} from "@/lib/platform-auth";
import { businessFeatures, setBusinessFeature, getBusiness } from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Every flag with this business's override and effective value — any admin reads. */
export async function GET(_request: NextRequest, ctx: Ctx) {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ features: await businessFeatures(id) });
}

/**
 * Set or clear a per-business flag override (`features.write`).
 *
 * `enabled: true|false` pins the flag for this business; `enabled: null` clears
 * the override so it follows the flag default. Audited with the flag key and
 * the value written, so a later "why did this business have X on?" has an
 * answer naming the admin who did it.
 */
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const { session, error } = await requirePlatformCapability("features.write");
  if (error) return error;

  const { id } = await ctx.params;
  let body: { flagKey?: string; enabled?: boolean | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const flagKey = body.flagKey?.trim();
  if (!flagKey) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (body.enabled !== null && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // A key that isn't in the catalogue writes nothing useful and would leave a
  // dangling override, so reject it up front.
  const flags = await businessFeatures(id);
  if (!flags.some((f) => f.key === flagKey)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await setBusinessFeature(id, flagKey, body.enabled ?? null);
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "feature.override",
    entity: "feature_flag",
    entityId: flagKey,
    payload: { flagKey, enabled: body.enabled ?? null },
  });

  return NextResponse.json({ features: await businessFeatures(id) });
}
