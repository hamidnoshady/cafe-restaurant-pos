/**
 * Phase 24 Wave 3 — field-level encryption primitives.
 *
 * Envelope: `POSFLD1` (7) | IV (12) | GCM tag (16) | ciphertext. The magic is
 * deliberately not `POSBKP1\0` (backup.ts): a value piped into the wrong
 * decryptor fails on the magic check rather than authenticating against the
 * wrong key and producing plausible nonsense.
 *
 * No key derivation here, unlike backup.ts — the input is already a 32-byte
 * DEK from `business-keys.ts`, so per-value scrypt would cost 16 MiB per row
 * for no security gain.
 *
 * Callers are the `*-service.ts` layer, never `db.ts`: a transparent database
 * layer cannot know which column is which and would encrypt the wrong things.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { ENCRYPTED_COLUMNS } from "./encrypted-columns";
import { phoneDigits, phoneE164 } from "./phone";

export { ENCRYPTED_COLUMNS } from "./encrypted-columns";

export const MAGIC = Buffer.from("POSFLD1", "latin1");
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;

export function encryptField(plain: string, dek: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function decryptField(data: Buffer, dek: Buffer): string {
  if (!isEncryptedField(data)) throw new Error("not an encrypted field (bad magic)");
  const minLength = MAGIC.length + IV_LENGTH + TAG_LENGTH;
  if (data.length < minLength) throw new Error("encrypted field is truncated");
  let off = MAGIC.length;
  const iv = data.subarray(off, (off += IV_LENGTH));
  const tag = data.subarray(off, (off += TAG_LENGTH));
  const ciphertext = data.subarray(off);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new Error("decryption failed — wrong dek or corrupted field");
  }
}

export function isEncryptedField(data: Buffer): boolean {
  return data.length > MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Null-tolerant wrappers. Every encrypted column is nullable and most rows
 * leave most of them empty, so "no value" has to round-trip as SQL NULL rather
 * than as the ciphertext of an empty string — otherwise `WHERE phone_enc IS
 * NULL`, which is what makes the backfill resumable, would stop finding rows
 * after the first pass.
 */
export function encryptOptional(plain: string | null | undefined, dek: Buffer): Buffer | null {
  if (plain === null || plain === undefined || plain === "") return null;
  return encryptField(plain, dek);
}

/**
 * Decrypts a column read back from Postgres, falling back to the plaintext
 * twin during the transition window. `value` is whatever `node-postgres`
 * handed back for the `bytea` column: a Buffer, or null.
 *
 * A ciphertext that fails to authenticate is *not* swallowed into the
 * fallback — that would mean a wrong-key install quietly serving stale
 * plaintext while writing ciphertext nobody can read. It throws.
 */
export function decryptOptional(
  value: unknown,
  dek: Buffer | null,
  fallback: string | null = null,
): string | null {
  if (value === null || value === undefined) return fallback;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  if (buffer.length === 0) return fallback;
  if (!dek) {
    // Ciphertext exists but this process has no key. Returning the plaintext
    // twin is right during the transition; once the plaintext columns are
    // dropped the caller sees null, which is the honest answer.
    return fallback;
  }
  if (!isEncryptedField(buffer)) return fallback;
  return decryptField(buffer, dek);
}

/**
 * Blind index — a deterministic HMAC that lets `WHERE phone_bidx = $1` do an
 * indexed equality lookup against a column nobody can read.
 *
 * The HMAC key is HKDF-derived from the business's DEK rather than the DEK
 * itself: the index is deterministic by construction (that is the whole
 * point), so it leaks equality, and a separate subkey keeps that leak from
 * touching the key that protects the ciphertext.
 *
 * Truncated to 32 hex characters (128 bits). Full width buys nothing — the
 * value is compared, never inverted — and a shorter index keeps the btree
 * smaller.
 */
export function blindIndexKey(dek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), Buffer.from("POSFLD1-bidx", "utf8"), 32));
}

export function blindIndex(value: string, dek: Buffer): string {
  return createHmac("sha256", blindIndexKey(dek)).update(value, "utf8").digest("hex").slice(0, 32);
}

/**
 * The blind index for a phone number.
 *
 * Normalised through `phoneE164` first, so `0912 123 4567`, `+98 912 123 4567`
 * and `۰۹۱۲۱۲۳۴۵۶۷` all land on one value — the same canonicalisation
 * `customers.phone_e164` already uses, deliberately, so that `phone_bidx` can
 * take over that column's equality joins (duplicate detection, segment
 * resolution) when the plaintext columns are dropped one release from now.
 *
 * A number that does not parse still gets an index, over its raw digits: a
 * mistyped landline is still the value someone will search for. Two *invalid*
 * numbers colliding is not a merge risk here, because nothing merges on the
 * blind index — `crm-service.ts`'s duplicate detection keeps its own
 * `phone_e164 IS NOT NULL` guard.
 *
 * Returns null for a value with no digits in it at all; there is nothing to
 * look up, and NULL is cheaper to index than a hash of "".
 */
export function phoneBlindIndex(phone: string | null | undefined, dek: Buffer): string | null {
  const digits = phoneDigits(phone);
  if (!digits) return null;
  return blindIndex(phoneE164(phone) ?? digits, dek);
}
