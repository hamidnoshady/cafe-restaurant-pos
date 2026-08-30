/**
 * Eshobe CMS — per-business connection storage (DB-touching, per repo
 * convention not unit-tested; the pure crypto lives in secrets.ts and the
 * pure config mapping below).
 *
 * One row per business: which CMS site this business owns, its domain, and
 * the site API key that grants access to it. The key is encrypted at rest
 * through `src/lib/integrations/secrets.ts` (AES-256-GCM under
 * `INTEGRATIONS_ENCRYPTION_KEY` or `JWT_SECRET`) — same store the WooCommerce
 * and Holoo credentials use — and is only ever decrypted on the way out to
 * the HTTP client. It is never returned to a browser and never logged.
 */
import { query } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import type { CmsConfig } from "./client";

/** Thrown by the connection store; `code` is what the API layer maps to a status. */
export class CmsConnectionError extends Error {
  readonly code: "not_connected";

  constructor() {
    super("no_eshobe_cms_connection");
    this.name = "CmsConnectionError";
    this.code = "not_connected";
  }
}

/** Row shape of `eshobe_cms_connections` (migration 0122). */
export interface CmsConnectionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  site_id: string;
  site_domain: string;
  base_url: string;
  key_name: string | null;
  api_key_ciphertext: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS = `id, business_id, site_id, site_domain, base_url, key_name,
       api_key_ciphertext, status, created_at, updated_at`;

/** Pure: map a stored row + the encryption key to the client config. */
export function cmsConfigFromRow(row: CmsConnectionRow, key: Buffer): CmsConfig {
  return {
    baseUrl: row.base_url,
    siteDomain: row.site_domain,
    apiKey: decryptSecret(row.api_key_ciphertext, key),
  };
}

export interface SaveCmsConnectionInput {
  businessId: string;
  /** The CMS site's uuid (what `POST /api/provision-site` returned as `site.id`). */
  siteId: string;
  /** The customer site's domain — the tenant on the CMS. */
  siteDomain: string;
  /** CMS control-plane origin. */
  baseUrl: string;
  /** `eshobe_live_…` — decrypted only here and in the client. */
  apiKey: string;
  keyName?: string;
}

export async function saveCmsConnection(input: SaveCmsConnectionInput): Promise<void> {
  const key = resolveEncryptionKey(process.env);
  await query(
    `INSERT INTO eshobe_cms_connections
       (business_id, site_id, site_domain, base_url, key_name, api_key_ciphertext)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (business_id) DO UPDATE SET
       site_id = EXCLUDED.site_id,
       site_domain = EXCLUDED.site_domain,
       base_url = EXCLUDED.base_url,
       key_name = EXCLUDED.key_name,
       api_key_ciphertext = EXCLUDED.api_key_ciphertext,
       status = 'active',
       updated_at = now()`,
    [
      input.businessId,
      input.siteId,
      input.siteDomain,
      input.baseUrl,
      input.keyName?.trim() || null,
      encryptSecret(input.apiKey, key),
    ],
  );
}

export async function deleteCmsConnection(businessId: string): Promise<void> {
  await query(`DELETE FROM eshobe_cms_connections WHERE business_id = $1`, [businessId]);
}

/**
 * The client config for one business — throws when the business has no CMS
 * connection (callers decide whether that is a 404 or a "not connected"
 * state) or when the stored ciphertext cannot be decrypted.
 */
export async function getCmsConfigForBusiness(businessId: string): Promise<CmsConfig> {
  const key = resolveEncryptionKey(process.env);
  const { rows } = await query<CmsConnectionRow>(
    `SELECT ${ROW_COLUMNS} FROM eshobe_cms_connections WHERE business_id = $1 AND status = 'active'`,
    [businessId],
  );
  const row = rows[0];
  if (!row) throw new CmsConnectionError();
  return cmsConfigFromRow(row, key);
}

/** Masked summary — safe for the browser (never contains the key). */
export interface CmsConnectionSummary {
  id: string;
  siteId: string;
  siteDomain: string;
  baseUrl: string;
  status: string;
  updatedAt: string;
}

export async function listCmsConnections(businessId: string): Promise<CmsConnectionSummary[]> {
  const { rows } = await query<CmsConnectionRow>(
    `SELECT id, site_id, site_domain, base_url, status, updated_at
       FROM eshobe_cms_connections WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    siteDomain: row.site_domain,
    baseUrl: row.base_url,
    status: row.status,
    updatedAt: row.updated_at,
  }));
}
