import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ENCRYPTED_COLUMNS } from "./encrypted-columns";

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
