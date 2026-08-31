/**
 * Phase 24 Wave 3 — the key-encryption key (KEK), the top of the two-level
 * key hierarchy.
 *
 * The KEK never encrypts a row. It only wraps each business's data-encryption
 * key (`src/lib/business-keys.ts`), which is what the `*_enc` columns are
 * actually encrypted under. That indirection is what makes crypto-shredding a
 * single tenant possible without re-keying every other one.
 *
 * Three sources, in precedence order:
 *
 *  1. `POS_MASTER_KEY` — 32 bytes as base64 or hex. The normal server case:
 *     generated once by the installer, held in the unit file / secret store,
 *     never in the database.
 *  2. `POS_MASTER_PASSPHRASE` — scrypt-derived with the same parameters as
 *     `backup.ts`'s artifact encryption (N=16384, r=8, p=1). Same shape, so an
 *     operator who has already internalised the backup passphrase rules does
 *     not have to learn a second set. The salt is fixed and public
 *     (`POSFLD1-kek`) because there is nothing here for a per-instance salt to
 *     do: there is exactly one KEK per install and it is not a stored hash an
 *     attacker can rainbow-table across installs.
 *  3. Electron `safeStorage` (DPAPI on Windows, Keychain on macOS) on the
 *     standalone install, where there is no unit file and no operator to hold
 *     a passphrase. The main process is expected to decrypt its stored blob at
 *     boot and hand it in via `setMasterKeyOverride` before any query runs;
 *     this module deliberately does not import anything from Electron, so that
 *     it stays loadable in the Next.js server runtime.
 *
 * **Absent all three, field encryption is off** and every service keeps
 * reading and writing plaintext. That is not a fallback that silently weakens
 * a configured install — a configured install has a KEK by definition — it is
 * what keeps an existing deployment (and the whole test suite) working across
 * the release that introduces the columns but before an operator has run
 * `npm run db:encrypt-fields`.
 */
import { scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
/** Same cost as backup.ts — 16 MiB, interactive-grade. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEK_SALT = Buffer.from("POSFLD1-kek", "utf8");

let override: Buffer | null = null;
let cached: { key: Buffer | null; source: MasterKeySource } | null = null;

export type MasterKeySource = "none" | "env_key" | "env_passphrase" | "runtime";

/**
 * Installs a KEK from outside the environment — the Electron main process
 * after `safeStorage.decryptString`, or a test. Clears the cache so the next
 * read sees it.
 */
export function setMasterKeyOverride(key: Buffer | null): void {
  if (key && key.length !== KEY_LENGTH) {
    throw new Error(`master key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  override = key;
  cached = null;
}

/** Forgets the memoised key. Call after mutating `process.env` in a test. */
export function resetMasterKeyCache(): void {
  cached = null;
}

/**
 * Decodes a 32-byte key from base64 or hex. Returns null (rather than
 * throwing) for anything else, so that a mistyped variable degrades to
 * "encryption not configured" and is reported once by `masterKeyStatus()`,
 * instead of taking down every request that touches a customer.
 */
export function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  } catch {
    /* fall through */
  }
  return null;
}

function resolve(): { key: Buffer | null; source: MasterKeySource } {
  if (override) return { key: override, source: "runtime" };

  const raw = process.env.POS_MASTER_KEY?.trim();
  if (raw) {
    const key = decodeMasterKey(raw);
    if (key) return { key, source: "env_key" };
    // Configured but unusable. Loud, once, and then treated as absent — see
    // the note on decodeMasterKey.
    console.error(
      "[field-crypto] POS_MASTER_KEY is set but is not 32 bytes of base64 or hex — field encryption is DISABLED",
    );
    return { key: null, source: "none" };
  }

  const passphrase = process.env.POS_MASTER_PASSPHRASE?.trim();
  if (passphrase) {
    return { key: scryptSync(passphrase, KEK_SALT, KEY_LENGTH, SCRYPT_PARAMS), source: "env_passphrase" };
  }

  return { key: null, source: "none" };
}

/** The KEK, or null when this install has not configured one. Memoised. */
export function getMasterKey(): Buffer | null {
  if (!cached) cached = resolve();
  return cached.key;
}

/** Throws rather than silently writing plaintext — for the backfill script and key minting. */
export function requireMasterKey(): Buffer {
  const key = getMasterKey();
  if (!key) {
    throw new Error(
      "no master key: set POS_MASTER_KEY (32 bytes, base64 or hex) or POS_MASTER_PASSPHRASE before encrypting fields",
    );
  }
  return key;
}

export function isFieldEncryptionEnabled(): boolean {
  return getMasterKey() !== null;
}

/** For a diagnostics readout: which source won, without revealing the key. */
export function masterKeyStatus(): { enabled: boolean; source: MasterKeySource } {
  if (!cached) cached = resolve();
  return { enabled: cached.key !== null, source: cached.source };
}

/**
 * Constant-time comparison of two candidate KEKs. Used only by the key-rotation
 * check in `business-keys.ts`, where a mismatch means "this wrapped DEK was
 * written under a different master key" and the operator needs to be told that
 * rather than shown a generic decryption failure.
 */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
