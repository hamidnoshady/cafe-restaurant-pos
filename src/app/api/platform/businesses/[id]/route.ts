import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  getBusiness,
  setBusinessStatus,
  setBusinessPlan,
  listPlans,
  hardDeleteBusiness,
  DeleteNotEligibleError,
  type BusinessStatus,
} from "@/lib/platform-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One business's summary — any admin reads. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ business });
});

const STATUS_CAPABILITY: Record<BusinessStatus, "business.suspend" | "business.archive"> = {
  active: "business.suspend",
  suspended: "business.suspend",
  archived: "business.archive",
};

/**
 * Move a business between lifecycle states, or reassign its plan.
 *
 * `status` transitions are the phase's suspend/reactivate/archive controls;
 * reactivating to `active` and suspending both need `business.suspend`, while
 * archiving is owner-only (`business.archive`). `plan` is a separate,
 * flag-writer action. Everything here is audited with the admin, business, and
 * new value — suspension leaves data untouched (exit criterion 2); the block
 * happens at login and the API guard, not by deletion.
 */
export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  // A generic admin check first so we can 401 before parsing; the capability
  // depends on what is being changed and is checked once we know.
  const auth = await requirePlatformAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  let body: { status?: BusinessStatus; plan?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.status !== undefined) {
    if (!["active", "suspended", "archived"].includes(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const cap = STATUS_CAPABILITY[body.status];
    const guard = await requirePlatformCapability(cap);
    if (guard.error) return guard.error;

    const updated = await setBusinessStatus(id, body.status);
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: `business.${body.status}`,
      entity: "business",
      entityId: id,
      payload: { status: body.status },
    });
    return NextResponse.json({ business: updated });
  }

  if (body.plan !== undefined) {
    const plan = body.plan.trim();
    if (!plan) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const guard = await requirePlatformCapability("features.write");
    if (guard.error) return guard.error;

    const existing = await getBusiness(id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const plans = await listPlans();
    if (!plans.some((p) => p.key === plan)) {
      return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
    }

    await setBusinessPlan(id, plan);
    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: "business.plan",
      entity: "business",
      entityId: id,
      payload: { plan },
    });
    return NextResponse.json({ business: await getBusiness(id) });
  }

  return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
});

/**
 * Hard-delete a business — irreversible, and only once it has been archived
 * past the grace window (open question 2: never immediate). Owner-only
 * (`business.delete`). The audit row survives the delete because
 * `platform_audit_log.business_id` is ON DELETE SET NULL, so the record that
 * it happened outlives the thing it happened to.
 */
export const DELETE = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.delete");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    // Audit first: the record must exist even if the delete then fails, and it
    // must capture the business's identity before the row disappears.
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "business.delete",
      entity: "business",
      entityId: id,
      payload: { name: business.name, slug: business.slug },
    });
    await hardDeleteBusiness(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DeleteNotEligibleError) {
      return NextResponse.json({ error: "delete_not_eligible" }, { status: 409 });
    }
    throw err;
  }
});
