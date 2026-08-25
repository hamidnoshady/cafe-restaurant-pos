/**
 * Phase 35 — Web Push, implemented against the RFCs rather than pulled in as a
 * dependency.
 *
 * Three specifications meet here, and each contributes exactly one piece:
 *
 *   * **RFC 8030** — the delivery protocol. A subscription is a URL; a push is
 *     a POST to it with a TTL header.
 *   * **RFC 8291** — payload encryption (`aes128gcm`). The browser hands the
 *     app server an ECDH public key and a 16-byte auth secret at subscribe
 *     time; everything sent afterwards is encrypted to that pair, so the push
 *     service in the middle carries a payload it cannot read. This is not
 *     optional — an unencrypted payload is simply rejected.
 *   * **RFC 8292 (VAPID)** — who the sender is. A signed ES256 JWT identifying
 *     this deployment, so a push service can rate-limit and contact whoever is
 *     sending, and so a subscription minted for us cannot be pushed to by
 *     someone else who learned its URL.
 *
 * Hand-rolled for the same reason `s3-lite.ts` is: the standard library already
 * has every primitive (ECDH, HKDF, AES-GCM, ECDSA), the wire format is a few
 * dozen lines of buffer concatenation, and the alternative is a dependency in
 * the trusted path of every notification the product sends. Everything here is
 * pure — it *builds* a request and never performs one — which is what lets
 * web-push.test.ts decrypt its own output and prove the format end to end.
 */
import {
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  createCipheriv,
  type KeyObject,
} from "crypto";

const CURVE = "prime256v1";
/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
const PUBLIC_KEY_BYTES = 65;
const PRIVATE_KEY_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Accepts standard base64 as well as base64url, and with or without padding.
 * Browsers are consistent about emitting base64url here, but a key that has
 * made a round trip through an operator's clipboard or a JSON file often has
 * not, and failing on it would present as "push silently stopped working".
 */
export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** base64url, 65 bytes — this is what the browser passes to pushManager.subscribe. */
  publicKey: string;
  /** base64url, 32 bytes. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  // Both halves are read off the *private* key's JWK rather than exporting the
  // public key object separately, so the stored pair cannot disagree with
  // itself — the failure that would present as "every push returns 401".
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  return {
    publicKey: toBase64Url(
      Buffer.concat([Buffer.from([0x04]), fromBase64Url(jwk.x), fromBase64Url(jwk.y)]),
    ),
    privateKey: toBase64Url(fromBase64Url(jwk.d)),
  };
}

/**
 * Rebuilds a signing key from the raw 32-byte scalar.
 *
 * The scalar alone is not a key any API accepts, so the public point is
 * recovered by scalar multiplication (`createECDH`, whose `getPublicKey` after
 * `setPrivateKey` is exactly that) and the pair assembled as a JWK. That is
 * also the check that the stored halves belong together: an x/y that does not
 * match `d` produces a key Node refuses to import.
 */
export function importVapidPrivateKey(privateKeyB64: string): KeyObject {
  const d = fromBase64Url(privateKeyB64);
  if (d.length !== PRIVATE_KEY_BYTES) {
    throw new Error(`VAPID private key must be ${PRIVATE_KEY_BYTES} bytes, got ${d.length}`);
  }
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: toBase64Url(d),
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
  });
}

/** The verifying half, for tests and for validating a stored pair at startup. */
export function importVapidPublicKey(publicKeyB64: string): KeyObject {
  const point = fromBase64Url(publicKeyB64);
  if (point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  }
  return createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: toBase64Url(point.subarray(1, 33)),
      y: toBase64Url(point.subarray(33, 65)),
    },
  });
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------

/**
 * The `aud` claim is the push service's *origin*, not the subscription URL.
 * Signing the full endpoint is the classic mistake here: every push service
 * rejects it, with a 401 that says nothing about why.
 */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

const TWELVE_HOURS_SECONDS = 12 * 60 * 60;

/**
 * A signed VAPID JWT for one push service.
 *
 * The signature is raw `r || s` (`ieee-p1363`), not the DER encoding
 * `createSign` produces by default — JWS ES256 is defined as the former, and
 * DER here is another silent 401.
 */
export function vapidToken(input: {
  endpoint: string;
  subject: string;
  privateKey: string;
  now?: Date;
  /** Push services cap this at 24h; 12 is the usual compromise between churn and slack. */
  expiresInSeconds?: number;
}): string {
  const now = input.now ?? new Date();
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: pushAudience(input.endpoint),
    exp: Math.floor(now.getTime() / 1000) + (input.expiresInSeconds ?? TWELVE_HOURS_SECONDS),
    sub: input.subject,
  };
  const signingInput =
    `${toBase64Url(Buffer.from(JSON.stringify(header)))}.` +
    `${toBase64Url(Buffer.from(JSON.stringify(claims)))}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  const signature = signer.sign({
    key: importVapidPrivateKey(input.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${toBase64Url(signature)}`;
}

// ---------------------------------------------------------------------------
// Payload encryption (RFC 8291 / RFC 8188)
// ---------------------------------------------------------------------------

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  // HKDF-Extract, then a single HKDF-Expand block — every output here is at
  // most 32 bytes, so the counter never leaves 0x01 and the loop the general
  // form would need is dead code.
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const okm = createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return okm.subarray(0, length);
}

export interface EncryptedPush {
  /** The complete `aes128gcm` body: header block followed by the single record. */
  body: Buffer;
  /** The ephemeral public key, also carried inside `body` — exposed for tests. */
  serverPublicKey: Buffer;
  salt: Buffer;
}

/**
 * Encrypts one payload to one subscription.
 *
 * A fresh ephemeral key pair per message is required, not merely tidy: reusing
 * one across messages to the same subscription reuses the AES-GCM nonce, which
 * is the failure mode that breaks GCM completely.
 *
 * The output is a single record with the whole payload in it, which is legal
 * and much simpler than the multi-record form — a notification is a few hundred
 * bytes and a push service will not carry 4 KB anyway.
 */
export function encryptPushPayload(input: {
  /** The subscription's `p256dh` key, base64url. */
  clientPublicKey: string;
  /** The subscription's `auth` secret, base64url (16 bytes). */
  clientAuthSecret: string;
  payload: string | Buffer;
  /** Injectable so the test can pin a vector; production always randomises. */
  salt?: Buffer;
  serverKeys?: { publicKey: Buffer; privateKey: Buffer };
}): EncryptedPush {
  const clientPublic = fromBase64Url(input.clientPublicKey);
  const authSecret = fromBase64Url(input.clientAuthSecret);
  if (clientPublic.length !== PUBLIC_KEY_BYTES || clientPublic[0] !== 0x04) {
    throw new Error("subscription p256dh must be a 65-byte uncompressed P-256 point");
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new Error(`subscription auth secret must be ${AUTH_SECRET_BYTES} bytes`);
  }

  const ecdh = createECDH(CURVE);
  if (input.serverKeys) ecdh.setPrivateKey(input.serverKeys.privateKey);
  else ecdh.generateKeys();
  const serverPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublic);

  // RFC 8291 §3.4: the auth secret is the HKDF *salt* for this first step, and
  // the info string binds the derivation to both parties' public keys — which
  // is what stops a payload encrypted for one subscription from being
  // meaningful to another.
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    clientPublic,
    serverPublicKey,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = input.salt ?? randomBytes(SALT_BYTES);
  const contentEncryptionKey = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const plaintext = Buffer.isBuffer(input.payload) ? input.payload : Buffer.from(input.payload, "utf8");
  // RFC 8188 §2: every record ends with a padding delimiter — 0x02 for the last
  // record, 0x01 otherwise. This is a single-record body, so 0x02.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 §2.1 header block: salt(16) || record_size(4, big-endian) ||
  // idlen(1) || keyid — where the key id is the sender's ephemeral public key.
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([serverPublicKey.length]),
    serverPublicKey,
  ]);

  return { body: Buffer.concat([header, ciphertext]), serverPublicKey, salt };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Everything needed to POST one notification, and nothing performed.
 *
 * `Urgency` is what tells a phone's push service whether this may wait for the
 * device to wake on its own: a failed backup is `high`, a shift opening is
 * `normal`. Getting it wrong costs battery on every device the business owns.
 */
export function buildPushRequest(input: {
  subscription: PushSubscriptionKeys;
  payload: string;
  vapid: { publicKey: string; privateKey: string; subject: string };
  /** Seconds the push service may hold this if the device is offline. */
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Collapses an older undelivered notification with the same key. */
  topic?: string;
  now?: Date;
}): PushRequest {
  const encrypted = encryptPushPayload({
    clientPublicKey: input.subscription.p256dh,
    clientAuthSecret: input.subscription.auth,
    payload: input.payload,
  });

  const token = vapidToken({
    endpoint: input.subscription.endpoint,
    subject: input.vapid.subject,
    privateKey: input.vapid.privateKey,
    now: input.now,
  });

  const headers: Record<string, string> = {
    Authorization: `vapid t=${token}, k=${input.vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(encrypted.body.length),
    TTL: String(input.ttlSeconds ?? 86_400),
    Urgency: input.urgency ?? "normal",
  };
  // A Topic must be a short base64url token; anything longer is rejected by the
  // push service outright, so a caller's dedupe key is hashed down rather than
  // passed through.
  if (input.topic) headers.Topic = pushTopic(input.topic);

  return { url: input.subscription.endpoint, method: "POST", headers, body: encrypted.body };
}

/** RFC 8030 §5.4 caps a Topic at 32 base64url characters. */
export function pushTopic(value: string): string {
  const compact = toBase64Url(
    createHmac("sha256", "push-topic").update(value).digest(),
  );
  return compact.slice(0, 32);
}

/**
 * How to treat a push service's answer.
 *
 * `gone` is the important one: 404 and 410 mean the subscription no longer
 * exists — the browser was uninstalled, the site data cleared, the permission
 * revoked — and the only correct response is to delete the device rather than
 * keep a dead row that fails forever. 429 and 5xx are the push service's
 * problem and worth retrying; 400/401/403 mean this deployment's VAPID setup or
 * payload is wrong and retrying it changes nothing.
 */
export type PushOutcome = "sent" | "gone" | "retry" | "rejected";

export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "rejected";
}
