/**
 * Phase 24 Wave 3 — per-business data-encryption keys (DEKs).
 *
 * Each business gets one 32-byte DEK, minted on first use and stored **wrapped
 * under the install's KEK** in `business_encryption_keys`. Per business rather
 * than one global key because it gives a per-tenant export its own key, bounds
 * a single-tenant key leak, and enables crypto-shredding — which is what makes
 * Phase 15's hard delete actually destructive rather than a `DELETE` a
 * forensics tool can undo.
 *
 * The wrapped DEK is inert without the KEK, and the KEK lives in the process
 * environment, not the database. The RLS policy on the table (migration
 * `0072_field_encryption.sql`) is defence-in-depth only.
 *
 * Reads go through a process-local cache keyed by business id: unwrapping is a
 * single AES-GCM operation, but the `SELECT` is not, and every customer row
 * read would otherwise pay for it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { query, withoutTenantScope } from "./db";
import { getMasterKey, requireMasterKey } from "./master-key";

/** Distinct from POSFLD1 so a wrapped DEK piped into the field decryptor fails on the magic. */
const WRAP_MAGIC = Buffer.from("POSKEK1", "latin1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const DEK_LENGTH = 32;
export const CURRENT_KEY_VERSION = 1;

const cache = new Map<string, Buffer>();

export function wrapDek(dek: Buffer, kek: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([WRAP_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function unwrapDek(wrapped: Buffer, kek: Buffer): Buffer {
  if (wrapped.length < WRAP_MAGIC.length || !wrapped.subarray(0, WRAP_MAGIC.length).equals(WRAP_MAGIC)) {
    throw new Error("not a wrapped DEK (bad magic)");
  }
  let off = WRAP_MAGIC.length;
  const iv = wrapped.subarray(off, (off += IV_LENGTH));
  const tag = wrapped.subarray(off, (off += TAG_LENGTH));
  const ciphertext = wrapped.subarray(off);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAuthTag(tag);
  try {
    const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dek.length !== DEK_LENGTH) throw new Error("unwrapped DEK has the wrong length");
    return dek;
  } catch {
    // Almost always "the KEK changed", not corruption. Say so — a generic
    // "decryption failed" sends an operator looking at their disk.
    throw new Error(
      "could not unwrap the business key — POS_MASTER_KEY/POS_MASTER_PASSPHRASE does not match the one this business's key was wrapped under",
    );
  }
}

export function generateDek(): Buffer {
  return randomBytes(DEK_LENGTH);
}

/**
 * The business's DEK, minting and storing one if this is the first encrypted
 * write for the business. Returns null when the install has no KEK at all,
 * which is how every caller learns to stay on the plaintext path.
 *
 * Runs under `withoutTenantScope`: key rows are read during provisioning and
 * by the backfill script, both of which run before/outside a tenant session,
 * and the query is pinned to a single `business_id` either way.
 */
export async function getBusinessDek(businessId: string): Promise<Buffer | null> {
  if (!getMasterKey()) return null;
  const cached = cache.get(businessId);
  if (cached) return cached;

  const kek = requireMasterKey();
  const dek = await withoutTenantScope("read/mint a business encryption key by explicit business_id", async () => {
    const { rows } = await query<{ wrapped_dek: Buffer }>(
      `SELECT wrapped_dek FROM business_encryption_keys WHERE business_id = $1 AND retired_at IS NULL`,
      [businessId],
    );
    if (rows[0]) return unwrapDek(toBuffer(rows[0].wrapped_dek), kek);

    const minted = generateDek();
    // ON CONFLICT DO NOTHING, then re-read: two requests for a brand-new
    // business can race here, and the loser must adopt the winner's key rather
    // than overwrite it — overwriting would orphan whatever the winner already
    // encrypted.
    await query(
      `INSERT INTO business_encryption_keys (business_id, key_version, wrapped_dek)
       VALUES ($1, $2, $3)
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId, CURRENT_KEY_VERSION, wrapDek(minted, kek)],
    );
    const { rows: after } = await query<{ wrapped_dek: Buffer }>(
      `SELECT wrapped_dek FROM business_encryption_keys WHERE business_id = $1 AND retired_at IS NULL`,
      [businessId],
    );
    return after[0] ? unwrapDek(toBuffer(after[0].wrapped_dek), kek) : minted;
  });

  cache.set(businessId, dek);
  return dek;
}

/**
 * Mints the key at business creation so that the very first customer written
 * is written encrypted. Safe to call when no KEK is configured — it does
 * nothing and provisioning carries on unencrypted.
 */
export async function ensureBusinessDek(businessId: string): Promise<void> {
  if (!getMasterKey()) return;
  await getBusinessDek(businessId);
}

/**
 * Crypto-shredding: retire the key and drop the wrapped copy. Every `*_enc`
 * value for the business becomes permanently unreadable, which is the point —
 * this is what makes a hard delete destructive. The row is kept (with a null
 * `wrapped_dek`) so that a later "why is this unreadable" question has an
 * answer with a timestamp on it.
 */
export async function shredBusinessDek(businessId: string): Promise<void> {
  cache.delete(businessId);
  await withoutTenantScope("crypto-shred a business encryption key by explicit business_id", async () => {
    await query(
      `UPDATE business_encryption_keys
          SET wrapped_dek = ''::bytea, retired_at = now()
        WHERE business_id = $1 AND retired_at IS NULL`,
      [businessId],
    );
  });
}

/** Drops the in-process cache. For the backfill script and tests. */
export function clearBusinessDekCache(businessId?: string): void {
  if (businessId) cache.delete(businessId);
  else cache.clear();
}

function toBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
}
