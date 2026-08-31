import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import {
  blindIndex,
  decryptField,
  decryptOptional,
  encryptField,
  encryptOptional,
  isEncryptedField,
  MAGIC,
  phoneBlindIndex,
} from "./field-crypto";
import { generateDek, unwrapDek, wrapDek } from "./business-keys";
import { decodeMasterKey } from "./master-key";

const dek = Buffer.alloc(32, 7);
const otherDek = Buffer.alloc(32, 9);

describe("encryptField / decryptField", () => {
  it("round-trips, including Persian text and emoji", () => {
    for (const value of ["09121234567", "تهران، خیابان ولیعصر، پلاک ۱۲", "note 🙂", " "]) {
      expect(decryptField(encryptField(value, dek), dek)).toBe(value);
    }
  });

  it("is non-deterministic — the same plaintext twice gives different ciphertext", () => {
    // Otherwise the column itself would be a blind index, and every customer
    // with the same address would be visibly grouped in a stolen dump.
    expect(encryptField("09121234567", dek).equals(encryptField("09121234567", dek))).toBe(false);
  });

  it("carries the POSFLD1 magic, deliberately not the backup's POSBKP1", () => {
    const out = encryptField("x", dek);
    expect(out.subarray(0, MAGIC.length).toString("latin1")).toBe("POSFLD1");
    expect(isEncryptedField(out)).toBe(true);
    expect(isEncryptedField(Buffer.from("POSBKP1\0rest", "latin1"))).toBe(false);
  });

  it("refuses the wrong key rather than returning nonsense", () => {
    expect(() => decryptField(encryptField("09121234567", dek), otherDek)).toThrow(/decryption failed/);
  });

  it("refuses a tampered ciphertext — GCM authenticates", () => {
    const out = encryptField("09121234567", dek);
    out[out.length - 1] ^= 0xff;
    expect(() => decryptField(out, dek)).toThrow(/decryption failed/);
  });

  it("refuses a truncated envelope and a foreign blob", () => {
    expect(() => decryptField(encryptField("x", dek).subarray(0, 20), dek)).toThrow(/truncated/);
    expect(() => decryptField(Buffer.from("just some bytes"), dek)).toThrow(/bad magic/);
  });
});

describe("encryptOptional / decryptOptional", () => {
  it("maps absence to SQL NULL, not to the ciphertext of an empty string", () => {
    // The backfill resumes on `WHERE col_enc IS NULL`; encrypting "" would
    // make every empty row look done on the first pass and never come back.
    expect(encryptOptional(null, dek)).toBeNull();
    expect(encryptOptional(undefined, dek)).toBeNull();
    expect(encryptOptional("", dek)).toBeNull();
  });

  it("falls back to the plaintext twin for a row the backfill has not reached", () => {
    expect(decryptOptional(null, dek, "09121234567")).toBe("09121234567");
    expect(decryptOptional(null, dek, null)).toBeNull();
  });

  it("prefers the ciphertext when both are present", () => {
    // The plaintext twin can be stale mid-migration; the ciphertext is what
    // the writing service last wrote.
    const enc = encryptField("09120000000", dek);
    expect(decryptOptional(enc, dek, "09121111111")).toBe("09120000000");
  });

  it("falls back rather than throwing when this process has no key at all", () => {
    expect(decryptOptional(encryptField("09121234567", dek), null, "plain")).toBe("plain");
  });

  it("throws on a ciphertext it cannot authenticate instead of silently serving the twin", () => {
    // Quietly falling back here would mean a wrong-key install serving stale
    // plaintext while writing ciphertext nobody can read.
    expect(() => decryptOptional(encryptField("x", dek), otherDek, "stale")).toThrow(/decryption failed/);
  });
});

describe("blind index", () => {
  it("is deterministic under one key and different under another", () => {
    expect(blindIndex("09121234567", dek)).toBe(blindIndex("09121234567", dek));
    expect(blindIndex("09121234567", dek)).not.toBe(blindIndex("09121234567", otherDek));
  });

  it("is not the DEK's own HMAC — the subkey is derived", () => {
    // The index is deterministic by construction and therefore leaks equality;
    // a separate HKDF subkey keeps that leak away from the key protecting the
    // ciphertext.
    const naive = createHmac("sha256", dek).update("09121234567").digest("hex").slice(0, 32);
    expect(blindIndex("09121234567", dek)).not.toBe(naive);
  });

  it("is 128 bits of hex — enough to compare, small enough to index", () => {
    expect(blindIndex("09121234567", dek)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("collapses every spelling of one phone number onto one value", () => {
    const canonical = phoneBlindIndex("09121234567", dek);
    for (const spelling of ["0912 123 4567", "+989121234567", "0098 912 123 4567", "۰۹۱۲۱۲۳۴۵۶۷"]) {
      expect(phoneBlindIndex(spelling, dek)).toBe(canonical);
    }
  });

  it("still indexes a number that does not parse, on its raw digits", () => {
    // A mistyped landline is still the value somebody will search for.
    expect(phoneBlindIndex("1234", dek)).toBe(blindIndex("1234", dek));
  });

  it("has nothing to index for a value with no digits", () => {
    expect(phoneBlindIndex(null, dek)).toBeNull();
    expect(phoneBlindIndex("", dek)).toBeNull();
    expect(phoneBlindIndex("no digits here", dek)).toBeNull();
  });

  it("distinguishes two different numbers", () => {
    expect(phoneBlindIndex("09121234567", dek)).not.toBe(phoneBlindIndex("09121234568", dek));
  });
});

describe("DEK wrapping", () => {
  const kek = Buffer.alloc(32, 3);

  it("round-trips a minted key", () => {
    const minted = generateDek();
    expect(minted).toHaveLength(32);
    expect(unwrapDek(wrapDek(minted, kek), kek).equals(minted)).toBe(true);
  });

  it("mints a different key every time", () => {
    expect(generateDek().equals(generateDek())).toBe(false);
  });

  it("uses its own magic so a wrapped DEK is not mistaken for a field", () => {
    expect(isEncryptedField(wrapDek(generateDek(), kek))).toBe(false);
  });

  it("says the master key changed rather than 'decryption failed'", () => {
    // An operator told "decryption failed" goes looking at their disk; told
    // the key does not match, they go looking at their environment.
    expect(() => unwrapDek(wrapDek(generateDek(), kek), randomBytes(32))).toThrow(/POS_MASTER_KEY/);
  });

  it("rejects a blob that is not a wrapped DEK", () => {
    expect(() => unwrapDek(Buffer.from("nonsense"), kek)).toThrow(/bad magic/);
  });
});

describe("decodeMasterKey", () => {
  it("accepts 32 bytes as hex or base64", () => {
    const key = randomBytes(32);
    expect(decodeMasterKey(key.toString("hex"))?.equals(key)).toBe(true);
    expect(decodeMasterKey(key.toString("base64"))?.equals(key)).toBe(true);
    expect(decodeMasterKey(`  ${key.toString("base64")}  `)?.equals(key)).toBe(true);
  });

  it("rejects a key of the wrong length rather than padding it", () => {
    expect(decodeMasterKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(decodeMasterKey(randomBytes(48).toString("hex"))).toBeNull();
    expect(decodeMasterKey("")).toBeNull();
    expect(decodeMasterKey("not-a-key")).toBeNull();
  });
});
