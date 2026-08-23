import { NextResponse } from "next/server";

/**
 * The deliberately small, explicit capability set exposed to an external
 * integration. This is not a tenant Role or Permission: a key is a
 * long-lived machine credential, so each capability has to be granted
 * directly when the key is issued.
 */
export const API_SCOPES = {
  ordersRead: "orders.read",
  ordersWrite: "orders.write",
  menuRead: "menu.read",
  menuWrite: "menu.write",
  inventoryRead: "inventory.read",
  reportsRead: "reports.read",
  webhooksManage: "webhooks.manage",
  // Phase 32 — the AI coworker over the public API, so a business can build a
  // sub app around it. Split three ways because reading the setup, changing
  // the setup, and approving a change the coworker wants to make are three
  // different levels of trust to hand a long-lived machine credential.
  accountingRead: "accounting.read",
  coworkerRead: "coworker.read",
  coworkerWrite: "coworker.write",
} as const;

export type ApiScope = (typeof API_SCOPES)[keyof typeof API_SCOPES];

export const ALL_API_SCOPES: ApiScope[] = Object.values(API_SCOPES);

/** True only for a scope this release recognises. Unknown stored values fail closed. */
export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (ALL_API_SCOPES as string[]).includes(value);
}

/**
 * Reads the text[] returned by Postgres defensively. A removed or misspelled
 * historical scope must never widen an API key's access, and duplicates do
 * not need to survive into the authenticated credential.
 */
export function parseApiScopes(value: unknown): ApiScope[] {
  if (!Array.isArray(value)) return [];

  const scopes: ApiScope[] = [];
  for (const candidate of value) {
    if (isApiScope(candidate) && !scopes.includes(candidate)) scopes.push(candidate);
  }
  return scopes;
}

export function hasApiScope(scopes: readonly ApiScope[], scope: ApiScope): boolean {
  return scopes.includes(scope);
}

/**
 * Route-level scope guard for the public API. Returning the response keeps
 * handlers in the same guard-and-short-circuit style as requirePermission.
 */
export function requireApiScope(scopes: readonly ApiScope[], scope: ApiScope): NextResponse | null {
  if (hasApiScope(scopes, scope)) return null;
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}
