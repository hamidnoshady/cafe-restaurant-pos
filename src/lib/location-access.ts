/**
 * Which branches a member may act in.
 *
 * Framework-free and pure (unit-tested in location-access.test.ts); the
 * DB-touching resolution that uses this lives in setup-state.ts, per the repo
 * convention that framework-free decision logic and its data lookup are
 * separate files.
 *
 * ## The rule used to be a fall-through, and the last case was a hole
 *
 * Before the authorization refactor this file resolved access by falling
 * through four cases, of which the fourth was "no `user_locations` rows and no
 * default `location_id` → every branch of the business". That made the
 * *absence of a decision* grant the *widest possible access*: any member
 * created by a path that did not set a home branch — an invitation accepted
 * without one, a form field left blank, an API-created member — silently
 * roamed every shop in the business, and no screen ever said so.
 *
 * ## It is now an explicit, stored policy
 *
 * `users.location_scope` (migration 0170) records the decision instead of
 * inferring it from missing data:
 *
 *   'all'      — every branch, now and in the future.
 *   'selected' — exactly the branches assigned in `user_locations`.
 *   'home'     — only the member's `location_id`.
 *
 * The column defaults to the NARROWEST value ('home'), and there is no
 * widening fallback left anywhere below: a member whose policy cannot be
 * satisfied reaches no branches rather than all of them. Deny by default.
 *
 * Existing members were backfilled to whatever reproduces the access they
 * already had (see 0170's header), so the deploy neither locks anyone out nor
 * escalates anyone; it only makes the policy visible and editable.
 *
 * `owner` remains whole-business by definition: ownership is not a branch
 * assignment, and restricting an owner to a subset of their own shops is not a
 * case worth modelling.
 */
import type { Role } from "./auth-edge";

/**
 * How broadly a member may move around the business's branches. Stored
 * explicitly on `users.location_scope` rather than inferred — see the header.
 */
export type LocationScope = "all" | "selected" | "home";

export const LOCATION_SCOPES: readonly LocationScope[] = ["all", "selected", "home"];

export function isLocationScope(value: unknown): value is LocationScope {
  return typeof value === "string" && (LOCATION_SCOPES as readonly string[]).includes(value);
}

export interface LocationAccessContext {
  role: Role;
  /** users.location_id — the member's default/home branch, if any. */
  defaultLocationId: string | null;
  /** user_locations rows for this member. Meaningful only when scope is 'selected'. */
  assignedLocationIds: string[];
  /**
   * users.location_scope. Optional so that a caller which has not yet been
   * migrated to select the column still behaves predictably; when it is absent
   * the scope is *derived* from the shape of the other two fields using the
   * same mapping migration 0170's backfill applies. That derivation is a
   * compatibility shim for reads, never a widening: it reproduces the stored
   * value the backfill would have written for this row.
   */
  scope?: LocationScope;
}

/**
 * The scope to use when a caller did not supply one, mirroring 0170's backfill
 * exactly so that a not-yet-migrated read and a migrated one agree.
 */
export function derivedLocationScope(
  ctx: Pick<LocationAccessContext, "role" | "defaultLocationId" | "assignedLocationIds">,
): LocationScope {
  if (ctx.role === "owner") return "all";
  if (ctx.assignedLocationIds.length > 0) return "selected";
  if (ctx.defaultLocationId) return "home";
  return "all";
}

/** The member's effective scope: what is stored, or what 0170 would have stored. */
export function effectiveLocationScope(ctx: LocationAccessContext): LocationScope {
  if (ctx.role === "owner") return "all";
  return ctx.scope ?? derivedLocationScope(ctx);
}

/**
 * Every branch (of the ones passed in, which should already be filtered to
 * the business's active locations) this member may act in.
 */
export function accessibleLocationIds(
  ctx: LocationAccessContext,
  businessLocationIds: string[],
): string[] {
  switch (effectiveLocationScope(ctx)) {
    case "all":
      return businessLocationIds;

    case "selected": {
      // Intersected with the business's own branches, never trusted as-is:
      // `assignedLocationIds` is a set of ids from `user_locations`, and the
      // intersection is what stops a stale or cross-tenant row from granting
      // anything. Callers pass only this business's active locations.
      const assigned = new Set(ctx.assignedLocationIds);
      return businessLocationIds.filter((id) => assigned.has(id));
    }

    case "home":
      // No home branch recorded means no branch — NOT every branch. This is
      // the fall-through that used to widen access; closing it is the point of
      // the explicit scope.
      return ctx.defaultLocationId && businessLocationIds.includes(ctx.defaultLocationId)
        ? [ctx.defaultLocationId]
        : [];
  }
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
