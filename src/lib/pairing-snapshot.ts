/**
 * The payload a desktop install receives when it redeems a pairing code, and
 * the validation it runs before touching its database.
 *
 * Pure — no imports beyond types — so it is unit-tested directly and can be
 * used on both sides: the online server builds a value of this shape
 * (pairing-service.ts) and the local install validates one (pairing-apply.ts).
 *
 * IDs are carried verbatim rather than regenerated. The local install ends up
 * holding the same business_id, location_id and user ids as the online
 * business, which is what makes Phase 11's sync_events replay correctly in
 * both directions afterwards.
 *
 * Credential hashes cross as-is (bcrypt output, never plaintext), so staff sign
 * in on the laptop with the PIN they already know.
 */

export const PAIRING_SNAPSHOT_VERSION = 1;

export interface SnapshotUser {
  id: string;
  role: string;
  fullName: string;
  email: string | null;
  permissions: Record<string, unknown>;
  pinHash: string | null;
  passwordHash: string | null;
  /**
   * The global identity behind this membership, recreated on the local side so
   * an owner can sign in with the same email and password they use online.
   * Null for a PIN-only member, who has no platform identity.
   */
  platformUserEmail: string | null;
  platformUserFullName: string | null;
  platformUserPasswordHash: string | null;
  locationIds: string[];
}

export interface SnapshotAccount {
  id: string;
  parentCode: string | null;
  code: string;
  name: string;
  type: string;
}

export interface SnapshotMenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SnapshotMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  /** Integer Rial, as everywhere else in this system. */
  price: number;
  imageUrl: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface SnapshotSetting {
  key: string;
  value: unknown;
}

export interface PairingSnapshot {
  version: number;
  business: {
    id: string;
    name: string;
    slug: string;
    /**
     * Phase 23. Optional so a snapshot minted by an older central server
     * still validates — the desktop side falls back to the slug, which is
     * what the column was backfilled from anyway (migration 0066).
     */
    subdomain?: string;
    timezone: string;
  };
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
  };
  users: SnapshotUser[];
  accounts: SnapshotAccount[];
  menu: { categories: SnapshotMenuCategory[]; items: SnapshotMenuItem[] };
  settings: SnapshotSetting[];
  features: Record<string, boolean>;
  /** Plaintext, delivered once — the local install stores only its hash via setServerSyncConfig. */
  syncToken: string;
}

export type SnapshotValidation =
  | { ok: true; snapshot: PairingSnapshot }
  | { ok: false; error: "snapshot_invalid" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SYNC_TOKEN_LENGTH = 16;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isIntegerAtLeastZero(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * A shape check, deliberately not a trust check: the code already
 * authenticated the caller, so this only guards against a truncated
 * response, a version skew, or a bug on the issuing side writing garbage into
 * an empty local database.
 */
export function validateSnapshot(raw: unknown): SnapshotValidation {
  const fail = { ok: false, error: "snapshot_invalid" } as const;
  if (!isObject(raw)) return fail;
  if (raw.version !== PAIRING_SNAPSHOT_VERSION) return fail;

  const business = raw.business;
  if (!isObject(business)) return fail;
  if (!isUuid(business.id)) return fail;
  if (typeof business.name !== "string" || !business.name) return fail;
  if (typeof business.slug !== "string" || !business.slug) return fail;
  if (business.subdomain !== undefined && (typeof business.subdomain !== "string" || !business.subdomain)) return fail;
  if (typeof business.timezone !== "string" || !business.timezone) return fail;

  const location = raw.location;
  if (!isObject(location)) return fail;
  if (!isUuid(location.id)) return fail;
  if (typeof location.name !== "string" || !location.name) return fail;
  if (!isNullableString(location.address)) return fail;
  if (!isNullableString(location.phone)) return fail;
  if (typeof location.timezone !== "string" || !location.timezone) return fail;

  if (!Array.isArray(raw.users) || raw.users.length === 0) return fail;
  for (const user of raw.users) {
    if (!isObject(user)) return fail;
    if (!isUuid(user.id)) return fail;
    if (typeof user.role !== "string" || !user.role) return fail;
    if (typeof user.fullName !== "string" || !user.fullName) return fail;
    if (!isNullableString(user.email)) return fail;
    if (!isObject(user.permissions)) return fail;
    if (!isNullableString(user.pinHash)) return fail;
    if (!isNullableString(user.passwordHash)) return fail;
    if (!isNullableString(user.platformUserEmail)) return fail;
    if (!isNullableString(user.platformUserFullName)) return fail;
    if (!isNullableString(user.platformUserPasswordHash)) return fail;
    if (!Array.isArray(user.locationIds) || !user.locationIds.every(isUuid)) return fail;
  }
  // Without an owner the local install would have nobody to sign in as, which
  // is a dead end the wizard cannot recover from.
  if (!raw.users.some((u) => isObject(u) && u.role === "owner")) return fail;

  if (!Array.isArray(raw.accounts)) return fail;
  for (const account of raw.accounts) {
    if (!isObject(account)) return fail;
    if (!isUuid(account.id)) return fail;
    if (!isNullableString(account.parentCode)) return fail;
    if (typeof account.code !== "string" || !account.code) return fail;
    if (typeof account.name !== "string" || !account.name) return fail;
    if (typeof account.type !== "string" || !account.type) return fail;
  }

  const menu = raw.menu;
  if (!isObject(menu)) return fail;
  if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) return fail;
  const categoryIds = new Set<string>();
  for (const category of menu.categories) {
    if (!isObject(category)) return fail;
    if (!isUuid(category.id)) return fail;
    if (typeof category.name !== "string" || !category.name) return fail;
    if (!Number.isInteger(category.sortOrder)) return fail;
    if (typeof category.isActive !== "boolean") return fail;
    categoryIds.add(category.id);
  }
  for (const item of menu.items) {
    if (!isObject(item)) return fail;
    if (!isUuid(item.id)) return fail;
    if (item.categoryId !== null && !isUuid(item.categoryId)) return fail;
    // A dangling category reference would violate the FK on insert, so catch
    // it here where the error is still a clean "snapshot_invalid".
    if (typeof item.categoryId === "string" && !categoryIds.has(item.categoryId)) return fail;
    if (typeof item.name !== "string" || !item.name) return fail;
    if (!isNullableString(item.description)) return fail;
    if (!isNullableString(item.sku)) return fail;
    if (!isIntegerAtLeastZero(item.price)) return fail;
    if (!isNullableString(item.imageUrl)) return fail;
    if (typeof item.isActive !== "boolean") return fail;
    if (!Number.isInteger(item.sortOrder)) return fail;
  }

  if (!Array.isArray(raw.settings)) return fail;
  for (const setting of raw.settings) {
    if (!isObject(setting)) return fail;
    if (typeof setting.key !== "string" || !setting.key) return fail;
  }

  if (!isObject(raw.features)) return fail;
  if (!Object.values(raw.features).every((v) => typeof v === "boolean")) return fail;

  if (typeof raw.syncToken !== "string" || raw.syncToken.length < MIN_SYNC_TOKEN_LENGTH) return fail;

  return { ok: true, snapshot: raw as unknown as PairingSnapshot };
}
