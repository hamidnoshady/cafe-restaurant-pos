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
import { API_KEY_PREFIX } from "./api-key-format";
import { businessScope, NO_SCOPE, runInTenantScope } from "./tenant-context";

// Re-exported so every existing importer keeps its single import site; the
// definitions live in api-key-format.ts because client code needs them and
// cannot follow this file's node:crypto/pg imports.
export { API_KEY_PREFIX, apiKeyDisplayPrefix } from "./api-key-format";
const MUTATING_API_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
        `SELECT k.id, k.business_id, k.location_id, k.scopes
           FROM api_keys k
           JOIN locations l
             ON l.id = k.location_id
            AND l.business_id = k.business_id
            AND l.is_active
          WHERE k.key_hash = $1
            AND k.status = 'active'
            AND (k.expires_at IS NULL OR k.expires_at > now())`,
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
              AND EXISTS (
                SELECT 1
                  FROM locations
                 WHERE id = api_keys.location_id
                   AND business_id = api_keys.business_id
                   AND is_active
              )
          RETURNING id`,
          [authentication.apiKeyId, authentication.businessId],
        ),
    );
    return touched.rows[0] ? authentication : null;
  });
}

/**
 * True for the public methods that are persisted in api_request_log. This
 * deliberately follows HTTP method semantics, so rejected write attempts are
 * visible to the owner too while high-volume reads stay out of the audit log.
 */
export function isApiMutation(method: string): boolean {
  return MUTATING_API_METHODS.has(method);
}

/**
 * Request auditing must not turn a committed business mutation into a 500
 * response (which could cause an integration retry and duplicate the work).
 * The database write is therefore best-effort, with no raw credential or
 * payload ever emitted to logs on a failure.
 */
async function persistApiRequestLog(
  apiKey: ApiKeyAuthentication,
  request: NextRequest,
  statusCode: number,
): Promise<void> {
  if (!isApiMutation(request.method)) return;
  try {
    await query(
      "INSERT INTO api_request_log (business_id, api_key_id, method, path, status_code) VALUES ($1, $2, $3, $4, $5)",
      [apiKey.businessId, apiKey.apiKeyId, request.method, request.nextUrl.pathname, statusCode],
    );
  } catch {
    console.error("api_request_log_failed", { apiKeyId: apiKey.apiKeyId });
  }
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
            const response = NextResponse.json({ error: "feature_disabled" }, { status: 403 });
            await persistApiRequestLog(apiKey, args[0], response.status);
            return response;
          }

          try {
            const response = await handler(apiKey, ...args);
            await persistApiRequestLog(apiKey, args[0], response.status);
            return response;
          } catch (error) {
            await persistApiRequestLog(apiKey, args[0], 500);
            throw error;
          }
        },
      );
    });
}
