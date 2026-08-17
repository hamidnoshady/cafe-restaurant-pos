/**
 * Issuing and revoking the public API keys that `src/lib/api-auth.ts`
 * authenticates.
 *
 * Phase 19 built the credential — the `api_keys` table, the hashing, the
 * bearer realm, the scope guard on every `/api/v1/*` route — and then stopped
 * one step short: nothing in the product could *create* one. A business that
 * wanted to build (or commission) an app against its own accounting data had a
 * fully working API and no way to obtain a key for it. This is that step.
 *
 * DB-touching, so no direct unit test per repo convention. The pure parts have
 * their own: `api-key-format.ts` for the shape, `api-scopes.ts` for the
 * capability set.
 */
import { query } from "./db";
import { createApiKey, hashApiKey } from "./api-auth";
import { apiKeyDisplayPrefix } from "./api-key-format";
import { isApiScope, parseApiScopes, type ApiScope } from "./api-scopes";

/** The safe shape: everything about a key except anything that could authenticate as it. */
export interface ApiKeySummary {
  id: string;
  name: string;
  /** The first 16 characters — enough to recognise a key in a log, never enough to use it. */
  keyPrefix: string;
  locationId: string;
  scopes: ApiScope[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  location_id: string;
  scopes: unknown;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

const COLUMNS = `id, name, key_prefix, location_id, scopes, status, last_used_at, expires_at, created_at, revoked_at`;

function mapKey(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    locationId: row.location_id,
    scopes: parseApiScopes(row.scopes),
    status: row.status,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export async function listApiKeys(businessId: string): Promise<ApiKeySummary[]> {
  const { rows } = await query<ApiKeyRow>(
    `SELECT ${COLUMNS} FROM api_keys WHERE business_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [businessId],
  );
  return rows.map(mapKey);
}

export interface CreateApiKeyInput {
  name: string;
  locationId: string;
  scopes: unknown;
  /** Optional lifetime in days; omitted means the key does not expire on its own. */
  expiresInDays?: number | null;
}

export type CreateApiKeyResult =
  | { ok: true; key: ApiKeySummary; secret: string }
  | { ok: false; error: "invalid_name" | "invalid_scopes" | "invalid_expiry" | "no_location" };

/** Bounds match the column's own CHECK, so a bad value is rejected with a named error rather than a 500. */
const MAX_NAME_LENGTH = 120;
const MAX_EXPIRY_DAYS = 3650;

/**
 * Mint a key. The secret exists only in this return value — only its SHA-256
 * and its display prefix are stored, the same rule pairing codes, invitations
 * and rollup tokens follow.
 *
 * Scopes are filtered through `isApiScope` rather than trusted: an unknown
 * string in the request must never widen a key, and the column's CHECK
 * constraint would otherwise turn a typo into a 500.
 */
export async function createApiKeyForBusiness(
  businessId: string,
  createdBy: string,
  input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
  const name = input.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return { ok: false, error: "invalid_name" };
  if (!input.locationId) return { ok: false, error: "no_location" };

  const scopes = Array.isArray(input.scopes) ? input.scopes.filter(isApiScope) : [];
  const unique = [...new Set(scopes)];
  if (unique.length === 0) return { ok: false, error: "invalid_scopes" };

  const days = input.expiresInDays ?? null;
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > MAX_EXPIRY_DAYS)) {
    return { ok: false, error: "invalid_expiry" };
  }

  const secret = createApiKey();
  const { rows } = await query<ApiKeyRow>(
    `INSERT INTO api_keys (business_id, location_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::numeric IS NULL THEN NULL ELSE now() + ($8 || ' days')::interval END)
     RETURNING ${COLUMNS}`,
    [
      businessId,
      input.locationId,
      name,
      apiKeyDisplayPrefix(secret),
      hashApiKey(secret),
      unique,
      createdBy,
      days,
    ],
  );
  return { ok: true, key: mapKey(rows[0]), secret };
}

/**
 * Revoke a key. Takes effect on that key's very next request — `api-auth.ts`
 * re-reads status on every call and caches nothing — which is the property the
 * whole "revoke" affordance rests on.
 *
 * Idempotent by the `status = 'active'` predicate: revoking an already-revoked
 * key reports `false` rather than rewriting `revoked_at`, which would falsify
 * the audit trail.
 */
export async function revokeApiKey(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE api_keys SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [id, businessId],
  );
  return (rowCount ?? 0) > 0;
}
