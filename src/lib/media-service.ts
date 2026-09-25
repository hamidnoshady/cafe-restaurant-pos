/**
 * «کتابخانهٔ رسانه» — the half that touches the database and the object
 * store. The decisions are all in `media.ts` (pure, unit-tested); this module
 * only executes them, the same split as platform-backup-service.ts.
 *
 * The one rule that matters most here: an object is only ever read, written
 * or deleted through its `media_assets` row, and the row's `storage_key` is
 * re-checked against the owning business with `keyBelongsToBusiness` before
 * s3-lite touches the network — RLS protects the row, this protects the
 * object, and both fail closed.
 *
 * The daily billing tick lives here too (`runMediaBillingTick`), in the shape
 * of `runWebsiteBillingTick`: claim the day's row ON CONFLICT DO NOTHING,
 * then debit through `chargeFeatureUse` — the single wallet every platform
 * feature spends from — and roll the claim back if the wallet cannot cover
 * it, so the business that tops up tomorrow is billed then.
 */
import { query, withTenant, withoutTenantScope } from "./db";
import {
  buildMediaKey,
  dailyStorageCharge,
  DEFAULT_MEDIA_CONFIG,
  keyBelongsToBusiness,
  mediaSearchExpression,
  mediaSortOrderBy,
  MEDIA_STORAGE_FEATURE_KEY,
  normalizeSearchTerm,
  type MediaKind,
  type MediaSort,
  type MediaStorageConfig,
} from "./media";
import { s3Delete, s3Get, s3Put, type S3Config } from "./s3-lite";
import { chargeFeatureUse, WalletInsufficientFundsError } from "./wallet-service";

// ---------------------------------------------------------------------------
// Config (the platform_media_config singleton)
// ---------------------------------------------------------------------------

type ConfigRow = {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  key_prefix: string;
  access_key_id: string;
  secret_access_key: string;
  billing_enabled: boolean;
  daily_flat_rial: string;
  daily_per_gb_rial: string;
  free_quota_mb: number;
  enhance_model: string;
  enhance_price_rial: string;
};

function rowToConfig(row: ConfigRow | undefined): MediaStorageConfig {
  if (!row) return { ...DEFAULT_MEDIA_CONFIG };
  return {
    enabled: row.enabled,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    keyPrefix: row.key_prefix,
    accessKeyId: row.access_key_id,
    secretAccessKey: row.secret_access_key,
    billingEnabled: row.billing_enabled,
    dailyFlatRial: Number(row.daily_flat_rial),
    dailyPerGbRial: Number(row.daily_per_gb_rial),
    freeQuotaMb: row.free_quota_mb,
    enhanceModel: row.enhance_model,
    enhancePriceRial: Number(row.enhance_price_rial),
  };
}

export async function getMediaConfig(): Promise<MediaStorageConfig> {
  const { rows } = await query<ConfigRow>(`SELECT * FROM platform_media_config WHERE id = true`);
  return rowToConfig(rows[0]);
}

export async function saveMediaConfig(config: MediaStorageConfig, adminId: string | null): Promise<void> {
  await query(
    `UPDATE platform_media_config SET
        enabled = $1, endpoint = $2, region = $3, bucket = $4, key_prefix = $5,
        access_key_id = $6, secret_access_key = $7,
        billing_enabled = $8, daily_flat_rial = $9, daily_per_gb_rial = $10, free_quota_mb = $11,
        enhance_model = $12, enhance_price_rial = $13,
        updated_by = $14, updated_at = now()
      WHERE id = true`,
    [
      config.enabled,
      config.endpoint,
      config.region,
      config.bucket,
      config.keyPrefix,
      config.accessKeyId,
      config.secretAccessKey,
      config.billingEnabled,
      config.dailyFlatRial,
      config.dailyPerGbRial,
      config.freeQuotaMb,
      config.enhanceModel,
      config.enhancePriceRial,
      adminId,
    ],
  );
}

function s3ConfigOf(config: MediaStorageConfig): S3Config {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
}

/** Ready to store: switched on with a complete connection. */
export function isMediaStorageReady(config: MediaStorageConfig): boolean {
  return config.enabled && Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey);
}

// ---------------------------------------------------------------------------
// Assets — upload / read / organize / delete
// ---------------------------------------------------------------------------

export type MediaAssetRecord = {
  id: string;
  folderId: string | null;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  category: string | null;
  tags: string[];
  aiStatus: "none" | "pending_review" | "confirmed" | "rejected";
  aiLabels: Record<string, unknown>;
  variant: "original" | "enhanced";
  sourceAssetId: string | null;
  /** Phase G — how the asset entered the library. */
  source: "upload" | "ai_attachment" | "ai_generated";
  /** Phase G — true when the assistant, not a person, authored the bytes. */
  createdByAi: boolean;
  /** Phase G — the chat this asset came from, if any. */
  conversationId: string | null;
  /** Phase G — the project workspace this asset belongs to, if any. */
  projectId: string | null;
  createdAt: string;
};

type AssetRow = {
  id: string;
  folder_id: string | null;
  kind: MediaKind;
  file_name: string;
  mime_type: string;
  byte_size: string;
  category: string | null;
  tags: string[];
  ai_status: MediaAssetRecord["aiStatus"];
  ai_labels: Record<string, unknown>;
  variant: MediaAssetRecord["variant"];
  source_asset_id: string | null;
  source: MediaAssetRecord["source"];
  created_by_ai: boolean;
  conversation_id: string | null;
  project_id: string | null;
  created_at: string;
};

const ASSET_COLUMNS =
  "id, folder_id, kind, file_name, mime_type, byte_size, category, tags, ai_status, ai_labels, variant, source_asset_id, source, created_by_ai, conversation_id, project_id, created_at";

function rowToAsset(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    folderId: row.folder_id,
    kind: row.kind,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    category: row.category,
    tags: row.tags ?? [],
    aiStatus: row.ai_status,
    aiLabels: row.ai_labels ?? {},
    variant: row.variant,
    sourceAssetId: row.source_asset_id,
    source: row.source,
    createdByAi: row.created_by_ai,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    createdAt: row.created_at,
  };
}

export interface MediaListFilter {
  folderId?: string | null | "any";
  kind?: MediaKind;
  category?: string;
  tag?: string;
  search?: string;
  aiStatus?: MediaAssetRecord["aiStatus"];
  /** Phase G — the workspace reads: a conversation's / a project's files. */
  conversationId?: string;
  projectId?: string;
  /** How the asset entered the library — upload / ai_attachment / ai_generated. */
  source?: MediaAssetRecord["source"];
  /** Newest first by default; see `MEDIA_SORTS` for the full set. */
  sort?: MediaSort;
  limit?: number;
  offset?: number;
}

/** The business's assets, filtered. RLS scopes the rows; this only narrows. */
export async function listMediaAssets(businessId: string, filter: MediaListFilter = {}) {
  const where: string[] = ["business_id = $1"];
  const params: unknown[] = [businessId];
  let i = 1;
  if (filter.folderId !== "any" && filter.folderId !== undefined) {
    if (filter.folderId === null) where.push("folder_id IS NULL");
    else {
      params.push(filter.folderId);
      where.push(`folder_id = $${++i}`);
    }
  }
  if (filter.kind) {
    params.push(filter.kind);
    where.push(`kind = $${++i}`);
  }
  if (filter.category) {
    params.push(filter.category);
    where.push(`category = $${++i}`);
  }
  if (filter.tag) {
    params.push(filter.tag);
    where.push(`$${++i} = ANY(tags)`);
  }
  if (filter.aiStatus) {
    params.push(filter.aiStatus);
    where.push(`ai_status = $${++i}`);
  }
  if (filter.conversationId) {
    params.push(filter.conversationId);
    where.push(`conversation_id = $${++i}`);
  }
  if (filter.projectId) {
    params.push(filter.projectId);
    where.push(`project_id = $${++i}`);
  }
  if (filter.source) {
    params.push(filter.source);
    where.push(`source = $${++i}`);
  }
  if (filter.search) {
    // Character-variant folding runs on BOTH sides (translate(...)), so a
    // term typed with Arabic ي/ك still finds a tag written with Persian ی/ک
    // — the stored value itself is never rewritten (src/lib/media.ts).
    const normalized = normalizeSearchTerm(filter.search);
    if (normalized) {
      params.push(`%${normalized}%`);
      const fileExpr = mediaSearchExpression("file_name");
      const categoryExpr = mediaSearchExpression("category");
      const tagExpr = mediaSearchExpression("t");
      where.push(
        `(${fileExpr} ILIKE $${++i} OR ${categoryExpr} ILIKE $${i} OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE ${tagExpr} ILIKE $${i}))`,
      );
    }
  }
  const limit = Math.min(Math.max(1, filter.limit ?? 60), 200);
  const offset = Math.max(0, filter.offset ?? 0);
  params.push(limit, offset);
  const { rows } = await query<AssetRow & { total: string }>(
    `SELECT ${ASSET_COLUMNS}, COUNT(*) OVER() AS total
       FROM media_assets
      WHERE ${where.join(" AND ")}
      ORDER BY ${mediaSortOrderBy(filter.sort)}, id DESC
      LIMIT $${++i} OFFSET $${++i}`,
    params,
  );
  return { assets: rows.map(rowToAsset), total: rows.length ? Number(rows[0].total) : 0 };
}

// ---------------------------------------------------------------------------
// Duplicate detection — tenant-scoped, by the bytes' own sha256
// ---------------------------------------------------------------------------

/**
 * An existing asset with the exact same bytes, in this business's own
 * library (sha256 is never compared across tenants). Callers use this before
 * storing a fresh upload so a picker can offer "use the existing file"
 * instead of writing a second identical object.
 */
export async function findMediaAssetByHash(businessId: string, sha256: string): Promise<MediaAssetRecord | null> {
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets WHERE business_id = $1 AND sha256 = $2 ORDER BY created_at ASC LIMIT 1`,
    [businessId, sha256],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Usage references — "where is this used?" / the safe-delete check
// ---------------------------------------------------------------------------

export interface MediaAssetUsageRef {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface MediaAssetUsage {
  menuItems: MediaAssetUsageRef[];
  inventoryItems: MediaAssetUsageRef[];
}

/**
 * Every catalogue row pointing at this asset through `image_media_id`.
 * `menu_items`/`inventory_items` carry no `business_id` column of their own
 * (they scope through `location_id` → `locations.business_id`), so this
 * relies on RLS — already true of every other read of these tables
 * (see branch-service.ts, ai-tools.ts) — rather than filtering twice.
 *
 * This is also the authorization primitive behind `/api/media/[id]/file`:
 * an operational role that cannot browse the library may still render a
 * photo already referenced by a record their own permission (menu.view,
 * inventory.view) already lets them see.
 */
export async function getMediaAssetUsage(assetId: string): Promise<MediaAssetUsage> {
  const [{ rows: menuItems }, { rows: inventoryItems }] = await Promise.all([
    query<MediaAssetUsageRef>(`SELECT id, name FROM menu_items WHERE image_media_id = $1 ORDER BY name`, [assetId]),
    query<MediaAssetUsageRef>(`SELECT id, name FROM inventory_items WHERE image_media_id = $1 ORDER BY name`, [
      assetId,
    ]),
  ]);
  return { menuItems, inventoryItems };
}

export function mediaAssetUsageIsEmpty(usage: MediaAssetUsage): boolean {
  return usage.menuItems.length === 0 && usage.inventoryItems.length === 0;
}

/** The distinct categories and tags in use — the filter dropdowns. */
export async function listMediaFacets(businessId: string) {
  const [{ rows: categories }, { rows: tags }] = await Promise.all([
    query<{ category: string }>(
      `SELECT DISTINCT category FROM media_assets WHERE business_id = $1 AND category IS NOT NULL ORDER BY category`,
      [businessId],
    ),
    query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag FROM media_assets WHERE business_id = $1 ORDER BY tag`,
      [businessId],
    ),
  ]);
  return { categories: categories.map((r) => r.category), tags: tags.map((r) => r.tag) };
}

export async function getMediaAsset(businessId: string, id: string): Promise<MediaAssetRecord | null> {
  const { rows } = await query<AssetRow>(
    `SELECT ${ASSET_COLUMNS} FROM media_assets WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return rows[0] ? rowToAsset(rows[0]) : null;
}

/**
 * Store bytes + row. The key is BUILT here from the caller's businessId —
 * never accepted from a request — which together with `keyBelongsToBusiness`
 * on every read is the whole tenant-isolation story inside the one bucket.
 * The S3 put happens before the row insert; a failed put leaves no row, a
 * failed insert leaves an unreferenced object the next delete sweep may
 * ignore (S3 storage is idempotent per assetId, so re-upload overwrites).
 */
export async function storeMediaAsset(input: {
  businessId: string;
  userId: string | null;
  config: MediaStorageConfig;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  folderId?: string | null;
  variant?: "original" | "enhanced";
  sourceAssetId?: string | null;
  /** Phase G — provenance. Defaults preserve the historic "human upload". */
  source?: "upload" | "ai_attachment" | "ai_generated";
  createdByAi?: boolean;
  conversationId?: string | null;
  projectId?: string | null;
}): Promise<MediaAssetRecord> {
  const { rows: idRows } = await query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  const assetId = idRows[0].id;
  const key = buildMediaKey(input.config.keyPrefix, input.businessId, assetId, input.fileName);

  await s3Put(s3ConfigOf(input.config), key, input.bytes);

  // The bytes are the assistant's own only for a generated image; an
  // ai_attachment is a user's file the assistant merely handled, so it is not
  // AI-authored. Derive the flag from source unless the caller overrides it.
  const source = input.source ?? "upload";
  const createdByAi = input.createdByAi ?? source === "ai_generated";

  const { rows } = await query<AssetRow>(
    `INSERT INTO media_assets
       (id, business_id, folder_id, kind, file_name, mime_type, byte_size, storage_key, sha256,
        variant, source_asset_id, created_by, source, created_by_ai, conversation_id, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING ${ASSET_COLUMNS}`,
    [
      assetId,
      input.businessId,
      input.folderId ?? null,
      input.kind,
      input.fileName.slice(0, 200),
      input.mimeType,
      input.bytes.byteLength,
      key,
      input.sha256,
      input.variant ?? "original",
      input.sourceAssetId ?? null,
      input.userId,
      source,
      createdByAi,
      input.conversationId ?? null,
      input.projectId ?? null,
    ],
  );
  return rowToAsset(rows[0]);
}

/**
 * The object's bytes, for serving/enhancing — after the fail-closed key check.
 */
export async function readMediaObject(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
): Promise<{ asset: MediaAssetRecord; bytes: Buffer } | null> {
  const { rows } = await query<AssetRow & { storage_key: string }>(
    `SELECT ${ASSET_COLUMNS}, storage_key FROM media_assets WHERE id = $1 AND business_id = $2`,
    [assetId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!keyBelongsToBusiness(row.storage_key, config.keyPrefix, businessId)) return null;
  const bytes = await s3Get(s3ConfigOf(config), row.storage_key);
  return { asset: rowToAsset(row), bytes };
}

/** Delete the row and then the object (best-effort — the row is the record). */
export async function deleteMediaAsset(
  businessId: string,
  assetId: string,
  config: MediaStorageConfig,
): Promise<boolean> {
  const { rows } = await query<{ storage_key: string }>(
    `DELETE FROM media_assets WHERE id = $1 AND business_id = $2 RETURNING storage_key`,
    [assetId, businessId],
  );
  const key = rows[0]?.storage_key;
  if (!key) return false;
  if (keyBelongsToBusiness(key, config.keyPrefix, businessId)) {
    await s3Delete(s3ConfigOf(config), key).catch(() => {
      // The row is gone, so the asset is gone for every user; a stranded
      // object costs storage until the operator prunes, never data exposure.
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type MediaFolderRecord = {
  id: string;
  parentId: string | null;
  name: string;
  assetCount: number;
};

export async function listMediaFolders(businessId: string): Promise<MediaFolderRecord[]> {
  const { rows } = await query<{ id: string; parent_id: string | null; name: string; asset_count: string }>(
    `SELECT f.id, f.parent_id, f.name,
            (SELECT COUNT(*) FROM media_assets a WHERE a.folder_id = f.id) AS asset_count
       FROM media_folders f
      WHERE f.business_id = $1
      ORDER BY f.name`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, assetCount: Number(r.asset_count) }));
}

// ---------------------------------------------------------------------------
// Usage + the daily billing tick
// ---------------------------------------------------------------------------

export interface MediaUsageSummary {
  totalBytes: number;
  assetCount: number;
  byKind: Record<MediaKind, { count: number; bytes: number }>;
}

export async function mediaUsageFor(businessId: string): Promise<MediaUsageSummary> {
  const { rows } = await query<{ kind: MediaKind; count: string; bytes: string }>(
    `SELECT kind, COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
       FROM media_assets WHERE business_id = $1 GROUP BY kind`,
    [businessId],
  );
  const byKind: MediaUsageSummary["byKind"] = {
    image: { count: 0, bytes: 0 },
    video: { count: 0, bytes: 0 },
    document: { count: 0, bytes: 0 },
  };
  let totalBytes = 0;
  let assetCount = 0;
  for (const row of rows) {
    byKind[row.kind] = { count: Number(row.count), bytes: Number(row.bytes) };
    totalBytes += Number(row.bytes);
    assetCount += Number(row.count);
  }
  return { totalBytes, assetCount, byKind };
}

/** Today's local (Asia/Tehran) calendar day as YYYY-MM-DD — the charge key. */
export function localBillingDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * The media billing tick: for every business storing anything, claim today's
 * charge row and debit the wallet. Idempotent per (business, local day) —
 * the UNIQUE claim means a second tick the same day does nothing — and an
 * empty wallet rolls the claim back so tomorrow's tick retries.
 */
export async function runMediaBillingTick(now: Date = new Date()): Promise<number> {
  const config = await withoutTenantScope("platform", () => getMediaConfig());
  if (!config.billingEnabled || (!config.dailyFlatRial && !config.dailyPerGbRial)) return 0;

  const day = localBillingDay(now);
  const holders = await withoutTenantScope("platform", async () => {
    const { rows } = await query<{ business_id: string; bytes: string }>(
      `SELECT a.business_id, SUM(a.byte_size) AS bytes
         FROM media_assets a
         JOIN businesses b ON b.id = a.business_id AND b.status = 'active'
        GROUP BY a.business_id
       HAVING SUM(a.byte_size) > 0`,
    );
    return rows;
  });

  let charged = 0;
  for (const holder of holders) {
    const breakdown = dailyStorageCharge(Number(holder.bytes), config);
    if (breakdown.totalRial <= 0) continue;
    try {
      await withTenant(holder.business_id, async () => {
        const { rows: claimed } = await query<{ id: string }>(
          `INSERT INTO media_usage_charges
             (business_id, day, stored_bytes, flat_rial, per_gb_rial, amount_rial)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (business_id, day) DO NOTHING
           RETURNING id`,
          [holder.business_id, day, Number(holder.bytes), breakdown.flatRial, breakdown.perGbRial, breakdown.totalRial],
        );
        if (!claimed[0]) return; // already billed today
        try {
          await chargeFeatureUse({
            businessId: holder.business_id,
            featureKey: MEDIA_STORAGE_FEATURE_KEY,
            priceRial: breakdown.totalRial,
            note: `هزینهٔ روزانهٔ فضای رسانه (${day})`,
            metadata: { day, storedBytes: Number(holder.bytes), metered: true },
          });
          charged += 1;
        } catch (error) {
          // A wallet that cannot cover today must be billable tomorrow.
          await query(`DELETE FROM media_usage_charges WHERE id = $1`, [claimed[0].id]);
          if (!(error instanceof WalletInsufficientFundsError)) throw error;
        }
      });
    } catch (error) {
      console.error("media billing tick failed for business:", holder.business_id, error);
    }
  }
  return charged;
}
