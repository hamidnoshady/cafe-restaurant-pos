/**
 * Phase 14 — which branches a member may act in.
 *
 * Framework-free and pure (unit-tested in location-access.test.ts); the
 * DB-touching resolution that uses this lives in setup-state.ts, per the repo
 * convention that framework-free decision logic and its data lookup are
 * separate files.
 *
 * The rule, in order:
 *   1. `owner` always reaches every branch of their business. Ownership is
 *      whole-business by definition — restricting an owner to a subset of
 *      their own branches isn't a real-world case worth modelling.
 *   2. An explicit `user_locations` assignment is the access set, full stop.
 *      This is what lets an owner give one manager two of five branches.
 *   3. No assignment but a default `location_id` (the shape every cashier,
 *      waiter and kitchen member has always had) restricts to that one
 *      branch — unchanged from pre-Phase-14 behaviour.
 *   4. No assignment and no default (`location_id` NULL, the pre-Phase-14
 *      "roaming manager") reaches every branch. This is also what makes a
 *      single-location business behave exactly as before: one location, no
 *      assignments, everyone reaches the only branch there is.
 */
import type { Role } from "./auth-edge";

export type LocationScope = "all" | "selected" | "home" | "none";

export interface LocationAccessContext {
  role: Role;
  /** Explicit policy persisted on users.location_scope. */
  locationScope?: LocationScope;
  /** users.location_id — the member's default/home branch, if any. */
  defaultLocationId: string | null;
  /** user_locations rows for this member. */
  assignedLocationIds: string[];
}

/**
 * Every branch (of the ones passed in, which should already be filtered to
 * the business's active locations) this member may act in.
 */
export function accessibleLocationIds(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
): string[] {
  if (ctx.role === "owner") return businessLocationIds;

  // Compatibility inference is only for callers/fixtures predating migration
  // 0170. Persisted production memberships always carry an explicit policy.
  const scope: LocationScope = ctx.locationScope ?? (
    ctx.assignedLocationIds.length > 0
      ? "selected"
      : ctx.defaultLocationId
        ? "home"
        : "all"
  );
  if (scope === "all") return businessLocationIds;
  if (scope === "none") return [];
  if (scope === "selected") {
    const assigned = new Set(ctx.assignedLocationIds);
    return businessLocationIds.filter((id) => assigned.has(id));
  }
  return ctx.defaultLocationId && businessLocationIds.includes(ctx.defaultLocationId)
    ? [ctx.defaultLocationId]
    : [];
}

export function canAccessLocation(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
  locationId: string,
): boolean {
  return accessibleLocationIds(ctx, businessLocationIds).includes(locationId);
}

/**
 * The branch that should be active when none has been explicitly (and
 * validly) chosen yet: the member's own default if it's still one they can
 * reach, otherwise the first accessible branch.
 *
 * `businessLocationIds` must be in a stable order (callers pass them sorted
 * by `created_at`) so "first accessible" is deterministic rather than
 * whatever order the database felt like returning.
 */
export function defaultAccessibleLocationId(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
): string | null {
  const accessible = accessibleLocationIds(ctx, businessLocationIds);
  if (accessible.length === 0) return null;
  if (ctx.defaultLocationId && accessible.includes(ctx.defaultLocationId)) {
    return ctx.defaultLocationId;
  }
  return accessible[0];
}

/** Whether this member may switch between branches at all, for the UI. */
export function canSwitchBranches(ctx: LocationAccessContext, businessLocationIds: string[]): boolean {
  return accessibleLocationIds(ctx, businessLocationIds).length > 1;
}
