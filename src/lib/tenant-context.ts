/**
 * Phase 12 — the per-request tenant context.
 *
 * Every tenant-scoped table is protected by a Row-Level Security policy keyed
 * on the `app.business_id` Postgres session setting (migration 0021). This
 * module is where the app decides what that setting should be for the work
 * currently in flight; `src/lib/db.ts` is what applies it to a connection.
 *
 * The context travels in an AsyncLocalStorage store rather than as a function
 * argument, because threading a businessId through 99 route handlers and the
 * ~40 service functions beneath them would be a far larger and far more
 * error-prone change than the isolation it buys. `getSession()` establishes it
 * once per request (see src/lib/auth.ts) and everything downstream inherits it.
 *
 * Two rules make this safe:
 *
 *   1. `getSession()` ALWAYS sets the context — to the caller's business when
 *      there is a session, and to `none` when there isn't. It never leaves a
 *      previous request's value in place to be inherited.
 *   2. `db.ts` applies the current context on EVERY connection checkout, never
 *      relying on what a pooled connection happened to be set to last time.
 *
 * Routes that intentionally run without a session (login, PIN login, signup,
 * token-authenticated server-to-server ingest) must therefore state their
 * intent explicitly with `withTenant()` or `withoutTenantScope()` from db.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Scoped to one business — the normal case for an authenticated request. */
export interface BusinessScope {
  kind: "business";
  businessId: string;
  /** The caller's active branch, when they have one. Advisory: RLS is per business. */
  locationId: string | null;
  /** users.id of the acting membership, for audit trails. */
  userId: string | null;
}

/**
 * Isolation deliberately stood down. Only two things legitimately need this:
 * resolving a login email to its memberships (which happens before a business
 * is chosen) and platform administration. Grep for `withoutTenantScope` to
 * audit every one of them.
 */
export interface BypassScope {
  kind: "bypass";
  reason: string;
}

/** No tenant chosen. Tenant tables read as empty — the fail-closed default. */
export interface NoScope {
  kind: "none";
}

export type TenantScope = BusinessScope | BypassScope | NoScope;

const storage = new AsyncLocalStorage<TenantScope>();

export const NO_SCOPE: NoScope = { kind: "none" };

/** The scope in force for the current async execution, or `none` if unset. */
export function getTenantScope(): TenantScope {
  return storage.getStore() ?? NO_SCOPE;
}

/** The active business, or null when unscoped or bypassed. */
export function getTenantBusinessId(): string | null {
  const scope = getTenantScope();
  return scope.kind === "business" ? scope.businessId : null;
}

/**
 * Set the scope for the remainder of the current execution.
 *
 * Uses `enterWith` rather than `run` so a guard can establish the context and
 * return, leaving the rest of the handler scoped, without every handler having
 * to wrap its body in a callback. The safety of this rests on rule 1 above:
 * because `getSession()` calls it unconditionally, a request can never silently
 * inherit the previous one's business.
 */
export function enterTenantScope(scope: TenantScope): void {
  storage.enterWith(scope);
}

/** Run `fn` under `scope`, restoring whatever was in force afterwards. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Convenience: a business scope from a session-shaped object. */
export function businessScope(
  businessId: string,
  locationId: string | null = null,
  userId: string | null = null,
): BusinessScope {
  return { kind: "business", businessId, locationId, userId };
}

/**
 * The GUC values a connection should be set to for a given scope.
 *
 * Pure, and the reason this module is unit-testable: it is the single place
 * that decides what Postgres sees, so the mapping from "who is asking" to
 * "what RLS will allow" can be asserted directly.
 *
 * An empty string is used rather than NULL because `set_config` takes text;
 * `app_current_business()` in migration 0021 maps '' back to NULL, which makes
 * every policy predicate false.
 */
export function scopeSettings(scope: TenantScope): { businessId: string; bypass: string } {
  switch (scope.kind) {
    case "business":
      return { businessId: scope.businessId, bypass: "" };
    case "bypass":
      return { businessId: "", bypass: "on" };
    case "none":
      return { businessId: "", bypass: "" };
  }
}
