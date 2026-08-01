/**
 * Phase 19 — bearer-token authentication for the public API.
 *
 * This is intentionally a third realm alongside tenant sessions and platform
 * sessions. A public API key identifies one business and one location, but
 * never impersonates a staff role; every allowed action is governed by its
 * explicitly granted ApiScope values instead.
 */
import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isFeatureEnabled } from "./features";
import { query, withoutTenantScope } from "./db";
import { parseApiScopes, type ApiScope } from "./api-scopes";
import { businessScope, NO_SCOPE, runInTenantScope } from "./tenant-context";

export const API_KEY_PREFIX = "posk_live_";
const API_KEY_DISPLAY_PREFIX_LENGTH = 16;

export interface ApiKeyAuthentication {
  apiKeyId: string;
  businessId: string;
  locationId: string;
  scopes: ApiScope[];
}

type ApiKeyRow = {
  id: string;
  business_id: string;
  location_id: string;
  scopes: unknown;
};

/** Generates a production API secret. Only hashApiKey(secret) is ever stored. */
export function createApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString("base64url");
}

/** The non-secret identifier safe to persist and show in the dashboard. */
export function apiKeyDisplayPrefix(secret: string): string {
  return secret.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** SHA-256 matches server-sync's indexed token-hash storage pattern. */
export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Extracts exactly one bearer credential. The key namespace check rejects
 * accidental tenant/platform credentials before a database lookup.
 */
export function parseApiBearerToken(request: Pick<Request, "headers">): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+([^\s]+)$/i);
  const token = match?.[1] ?? null;
  return token?.startsWith(API_KEY_PREFIX) ? token : null;
}

/**
 * Resolves a public key before any tenant is known. This is the documented
 * api-key-auth bypass: the token itself is how the tenant gets selected.
 *
 * The key is always queried fresh and touched with a conditional update, so a
 * revocation/expiry takes effect on the next request with no credential cache.
 */
export async function authenticateApiKey(
  request: Pick<Request, "headers">,
): Promise<ApiKeyAuthentication | null> {
  return runInTenantScope(NO_SCOPE, async () => {
    const token = parseApiBearerToken(request);
    if (!token) return null;

    const { rows } = await withoutTenantScope("api-key-auth", () =>
      query<ApiKeyRow>(
        `SELECT id, business_id, location_id, scopes
           FROM api_keys
          WHERE key_hash = $1
            AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())`,
        [hashApiKey(token)],
      ),
    );
    const row = rows[0];
    if (!row) return null;

    const authentication: ApiKeyAuthentication = {
      apiKeyId: row.id,
      businessId: row.business_id,
      locationId: row.location_id,
      scopes: parseApiScopes(row.scopes),
    };

    // Re-check active/expiry while writing inside the resolved tenant. If a
    // revocation won the race after the lookup, deny rather than carrying on
    // with a credential that is no longer active.
    const touched = await runInTenantScope(
      businessScope(authentication.businessId, authentication.locationId),
      () =>
        query<{ id: string }>(
          `UPDATE api_keys
              SET last_used_at = now()
            WHERE id = $1
              AND business_id = $2
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > now())
          RETURNING id`,
          [authentication.apiKeyId, authentication.businessId],
        ),
    );
    return touched.rows[0] ? authentication : null;
  });
}

/**
 * Establishes the resolved business/location scope for an entire public API
 * handler. The outer NO_SCOPE is deliberate: both an absent key and a failed
 * key check must fail closed, never inherit ambient scope from unrelated
 * work; the successful path then uses AsyncLocalStorage.run() for the whole
 * handler, which remains safe while background ticks interleave.
 */
export function withApiKeyScope<Args extends [NextRequest, ...unknown[]]>(
  handler: (apiKey: ApiKeyAuthentication, ...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) =>
    runInTenantScope(NO_SCOPE, async () => {
      const apiKey = await authenticateApiKey(args[0]);
      if (!apiKey) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }

      return runInTenantScope(
        businessScope(apiKey.businessId, apiKey.locationId),
        async () => {
          // Public API requests never pass through withTenantScope(), so this
          // feature check intentionally lives here rather than in features.ts
          // session-oriented prefix mapping.
          if (!(await isFeatureEnabled(apiKey.businessId, "api_platform"))) {
            return NextResponse.json({ error: "feature_disabled" }, { status: 403 });
          }
          return handler(apiKey, ...args);
        },
      );
    });
}
