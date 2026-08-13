import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  resolveEncryptionKey,
} from "./secrets";

describe("deriveEncryptionKey", () => {
  it("is deterministic and 32 bytes", () => {
    const a = deriveEncryptionKey("passphrase");
    const b = deriveEncryptionKey("passphrase");
    expect(a).toEqual(b);
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(deriveEncryptionKey("other"));
  });
});

describe("encryptSecret / decryptSecret", () => {
  const key = deriveEncryptionKey("test-key");

  it("round-trips a secret", () => {
    const ciphertext = encryptSecret("ck_abc123", key);
    expect(ciphertext).toMatch(/^v1\./);
    expect(ciphertext).not.toContain("ck_abc123");
    expect(decryptSecret(ciphertext, key)).toBe("ck_abc123");
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const a = encryptSecret("ck_abc123", key);
    const b = encryptSecret("ck_abc123", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe(decryptSecret(b, key));
  });

  it("rejects a wrong key", () => {
    const ciphertext = encryptSecret("ck_abc123", key);
    expect(() => decryptSecret(ciphertext, deriveEncryptionKey("wrong"))).toThrow(/decryption failed/);
  });

  it("rejects tampering", () => {
    const ciphertext = encryptSecret("ck_abc123", key);
    const parts = ciphertext.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow(/decryption failed/);
  });

  it("rejects a malformed ciphertext", () => {
    expect(() => decryptSecret("not-a-ciphertext", key)).toThrow(/malformed/);
  });

  it("rejects a wrong-sized key", () => {
    expect(() => encryptSecret("x", Buffer.from("short"))).toThrow(/32 bytes/);
  });
});

describe("resolveEncryptionKey", () => {
  it("uses an explicit 64-hex key", () => {
    const hex = "ab".repeat(32);
    expect(resolveEncryptionKey({ INTEGRATIONS_ENCRYPTION_KEY: hex })).toEqual(Buffer.from(hex, "hex"));
  });

  it("rejects a malformed explicit key", () => {
    expect(() => resolveEncryptionKey({ INTEGRATIONS_ENCRYPTION_KEY: "nope" })).toThrow(/64 hex/);
  });

  it("falls back to JWT_SECRET", () => {
    expect(resolveEncryptionKey({ JWT_SECRET: "fallback" })).toEqual(deriveEncryptionKey("fallback"));
  });

  it("fails when nothing is set", () => {
    expect(() => resolveEncryptionKey({})).toThrow(/JWT_SECRET/);
  });
});
