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
  updateBusiness,
  resetBusiness,
  listPlans,
  hardDeleteBusiness,
  BusinessNotFoundError,
  ResetBusinessNotPossibleError,
  type BusinessStatus,
} from "@/lib/platform-service";
import { DESTRUCTIVE_CONFIRMATION_PHRASE } from "@/lib/platform-admin";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
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
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const hasStatus = body.status !== undefined;
  const hasPlan = body.plan !== undefined;
  const hasMetadata = body.name !== undefined || body.timezone !== undefined;
  if (Number(hasStatus) + Number(hasPlan) + Number(hasMetadata) !== 1) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (hasStatus) {
    if (
      typeof body.status !== "string" ||
      !["active", "suspended", "archived"].includes(body.status)
    ) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const status = body.status as BusinessStatus;
    const cap = STATUS_CAPABILITY[status];
    const guard = await requirePlatformCapability(cap);
    if (guard.error) return guard.error;

    const updated = await setBusinessStatus(id, status);
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: "business." + status,
      entity: "business",
      entityId: id,
      payload: { status },
    });
    return NextResponse.json({ business: updated });
  }

  if (hasPlan) {
    if (typeof body.plan !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
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

  const name =
    body.name === undefined
      ? undefined
      : typeof body.name === "string"
        ? body.name.trim()
        : null;
  const timezone =
    body.timezone === undefined
      ? undefined
      : typeof body.timezone === "string"
        ? body.timezone.trim()
        : null;
  if (name === null || timezone === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (name !== undefined && !name) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (timezone !== undefined && (!timezone || !isValidTimezone(timezone))) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }

  const guard = await requirePlatformCapability("business.edit");
  if (guard.error) return guard.error;

  const updated = await updateBusiness(id, { name, timezone });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const payload: Record<string, string> = {};
  if (name !== undefined) payload.name = name;
  if (timezone !== undefined) payload.timezone = timezone;
  await platformAudit({
    adminId: guard.session.padmin,
    businessId: id,
    action: "business.edit",
    entity: "business",
    entityId: id,
    payload,
  });
  return NextResponse.json({ business: updated });
});

/**
 * Factory-reset one business after typing the fixed confirmation phrase. The
 * shared owner identity and subscription plan survive, but all tenant data is
 * deleted and the owner returns to the first-run setup wizard.
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.reset");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
  if (confirmation !== DESTRUCTIVE_CONFIRMATION_PHRASE) {
    return NextResponse.json({ error: "reset_confirmation_required" }, { status: 400 });
  }

  try {
    await resetBusiness(id);
  } catch (err) {
    if (err instanceof ResetBusinessNotPossibleError) {
      return NextResponse.json({ error: "reset_not_possible" }, { status: 409 });
    }
    // resetBusiness is one transaction, so this response also guarantees that
    // no partial reset was committed. Keep the database detail in server logs.
    console.error("platform business reset failed", { businessId: id, err });
    return NextResponse.json({ error: "reset_failed" }, { status: 500 });
  }

  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "business.reset",
    entity: "business",
    entityId: id,
    payload: { name: business.name, slug: business.slug, plan: business.plan },
  });
  return NextResponse.json({ ok: true });
});

/**
 * Hard-delete a business — immediately, irreversibly, no archive step and no
 * grace window. Owner-only (`business.delete`) and gated on the same fixed
 * confirmation phrase as reset — with the grace window gone, that pairing
 * (owner capability + typed phrase) is the only safety net left. The audit
 * row survives the delete because `platform_audit_log.business_id` is
 * ON DELETE SET NULL, so the record that it happened outlives the thing it
 * happened to.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.delete");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
  if (confirmation !== DESTRUCTIVE_CONFIRMATION_PHRASE) {
    return NextResponse.json({ error: "delete_confirmation_required" }, { status: 400 });
  }

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

  try {
    await hardDeleteBusiness(id);
  } catch (err) {
    if (err instanceof BusinessNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // hardDeleteBusiness is one transaction, so this response also guarantees
    // no partial delete was committed. Keep the database detail in server logs.
    console.error("platform business delete failed", { businessId: id, err });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
});
