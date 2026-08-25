import { describe, expect, it } from "vitest";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createVerify,
  randomBytes,
} from "crypto";
import {
  buildPushRequest,
  classifyPushStatus,
  encryptPushPayload,
  fromBase64Url,
  generateVapidKeys,
  importVapidPrivateKey,
  importVapidPublicKey,
  pushAudience,
  pushTopic,
  toBase64Url,
  vapidToken,
} from "./web-push";

/**
 * A stand-in for the browser: an ECDH key pair plus a 16-byte auth secret, which
 * is exactly what `pushManager.subscribe()` hands the application server.
 */
function fakeSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    p256dh: toBase64Url(ecdh.getPublicKey()),
    auth: toBase64Url(randomBytes(16)),
    privateKey: ecdh.getPrivateKey(),
  };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest()
    .subarray(0, length);
}

/**
 * The receiver's half of RFC 8291, written independently of the sender so the
 * round trip proves the wire format rather than proving that one function is
 * the inverse of itself. This is what a real browser does with the body.
 */
function decryptPushBody(body: Buffer, subscription: ReturnType<typeof fakeSubscription>): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublicKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(subscription.privateKey);
  const sharedSecret = ecdh.computeSecret(serverPublicKey);

  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    fromBase64Url(subscription.p256dh),
    serverPublicKey,
  ]);
  const ikm = hkdf(fromBase64Url(subscription.auth), sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // Strip the RFC 8188 padding delimiter (0x02 on the final record).
  expect(record[record.length - 1]).toBe(0x02);
  return record.subarray(0, record.length - 1).toString("utf8");
}

describe("generateVapidKeys", () => {
  it("produces a 65-byte uncompressed point and a 32-byte scalar", () => {
    const keys = generateVapidKeys();
    const point = fromBase64Url(keys.publicKey);
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(0x04);
    expect(fromBase64Url(keys.privateKey)).toHaveLength(32);
  });

  it("produces halves that belong to each other", () => {
    const keys = generateVapidKeys();
    // Re-deriving the public point from the private scalar must land on the
    // stored public key; a mismatch is the bug that makes every push 401.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromBase64Url(keys.privateKey));
    expect(toBase64Url(ecdh.getPublicKey())).toBe(keys.publicKey);
  });

  it("round-trips through the key importers", () => {
    const keys = generateVapidKeys();
    expect(() => importVapidPrivateKey(keys.privateKey)).not.toThrow();
    expect(() => importVapidPublicKey(keys.publicKey)).not.toThrow();
  });

  it("refuses a malformed public key", () => {
    expect(() => importVapidPublicKey(toBase64Url(Buffer.alloc(64)))).toThrow(/65-byte/);
  });

  it("refuses a malformed private key", () => {
    expect(() => importVapidPrivateKey(toBase64Url(Buffer.alloc(16)))).toThrow(/32 bytes/);
  });
});

describe("pushAudience", () => {
  it("is the push service origin, not the subscription path", () => {
    expect(pushAudience("https://fcm.googleapis.com/fcm/send/xyz")).toBe("https://fcm.googleapis.com");
    expect(pushAudience("https://web.push.apple.com/QAbc/deep/path?x=1")).toBe(
      "https://web.push.apple.com",
    );
  });
});

describe("vapidToken", () => {
  const keys = generateVapidKeys();
  const now = new Date("2026-03-01T10:00:00.000Z");

  it("carries aud/sub/exp claims a push service will accept", () => {
    const token = vapidToken({
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
      subject: "mailto:ops@example.com",
      privateKey: keys.privateKey,
      now,
    });
    const [header, claims] = token
      .split(".")
      .slice(0, 2)
      .map((part) => JSON.parse(fromBase64Url(part).toString("utf8")));

    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims.aud).toBe("https://updates.push.services.mozilla.com");
    expect(claims.sub).toBe("mailto:ops@example.com");
    expect(claims.exp).toBe(Math.floor(now.getTime() / 1000) + 12 * 60 * 60);
  });

  it("signs with a raw r||s signature the matching public key verifies", () => {
    const token = vapidToken({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      subject: "https://pos.example.com",
      privateKey: keys.privateKey,
      now,
    });
    const parts = token.split(".");
    const signature = fromBase64Url(parts[2]);
    // JWS ES256 is 64 bytes of r||s. A DER signature would be ~70 and variable,
    // which every push service rejects with an unexplained 401.
    expect(signature).toHaveLength(64);

    const verifier = createVerify("SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    expect(
      verifier.verify(
        { key: importVapidPublicKey(keys.publicKey), dsaEncoding: "ieee-p1363" },
        signature,
      ),
    ).toBe(true);
  });
});

describe("encryptPushPayload", () => {
  it("produces a body the subscription's own keys decrypt", () => {
    const subscription = fakeSubscription();
    const payload = JSON.stringify({ title: "کسری صندوق", body: "۴۰٬۰۰۰ تومان" });
    const { body } = encryptPushPayload({
      clientPublicKey: subscription.p256dh,
      clientAuthSecret: subscription.auth,
      payload,
    });
    expect(decryptPushBody(body, subscription)).toBe(payload);
  });

  it("lays out the aes128gcm header exactly as RFC 8188 specifies", () => {
    const subscription = fakeSubscription();
    const salt = randomBytes(16);
    const { body, serverPublicKey } = encryptPushPayload({
      clientPublicKey: subscription.p256dh,
      clientAuthSecret: subscription.auth,
      payload: "x",
      salt,
    });
    expect(body.subarray(0, 16).equals(salt)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.subarray(21, 86).equals(serverPublicKey)).toBe(true);
  });

  it("uses a fresh ephemeral key per message", () => {
    const subscription = fakeSubscription();
    const first = encryptPushPayload({
      clientPublicKey: subscription.p256dh,
      clientAuthSecret: subscription.auth,
      payload: "same",
    });
    const second = encryptPushPayload({
      clientPublicKey: subscription.p256dh,
      clientAuthSecret: subscription.auth,
      payload: "same",
    });
    // Reusing the ephemeral pair would reuse the AES-GCM nonce for the same
    // subscription, which breaks GCM outright.
    expect(first.serverPublicKey.equals(second.serverPublicKey)).toBe(false);
    expect(first.body.equals(second.body)).toBe(false);
  });

  it("cannot be decrypted with a different subscription's key", () => {
    const intended = fakeSubscription();
    const other = fakeSubscription();
    const { body } = encryptPushPayload({
      clientPublicKey: intended.p256dh,
      clientAuthSecret: intended.auth,
      payload: "secret",
    });
    expect(() => decryptPushBody(body, other)).toThrow();
  });

  it("refuses a subscription with a malformed key or auth secret", () => {
    const subscription = fakeSubscription();
    expect(() =>
      encryptPushPayload({
        clientPublicKey: toBase64Url(Buffer.alloc(10)),
        clientAuthSecret: subscription.auth,
        payload: "x",
      }),
    ).toThrow(/p256dh/);
    expect(() =>
      encryptPushPayload({
        clientPublicKey: subscription.p256dh,
        clientAuthSecret: toBase64Url(Buffer.alloc(8)),
        payload: "x",
      }),
    ).toThrow(/auth secret/);
  });
});

describe("buildPushRequest", () => {
  const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };

  it("targets the subscription endpoint with the headers RFC 8030 requires", () => {
    const subscription = fakeSubscription("https://web.push.apple.com/Q123");
    const request = buildPushRequest({
      subscription,
      payload: '{"title":"سلام"}',
      vapid,
      ttlSeconds: 3600,
      urgency: "high",
    });

    expect(request.url).toBe("https://web.push.apple.com/Q123");
    expect(request.method).toBe("POST");
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.headers.TTL).toBe("3600");
    expect(request.headers.Urgency).toBe("high");
    expect(request.headers["Content-Length"]).toBe(String(request.body.length));
    expect(request.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    expect(request.headers.Authorization.endsWith(`k=${vapid.publicKey}`)).toBe(true);
    expect(decryptPushBody(request.body, subscription)).toBe('{"title":"سلام"}');
  });

  it("defaults to a one-day TTL and normal urgency", () => {
    const request = buildPushRequest({ subscription: fakeSubscription(), payload: "{}", vapid });
    expect(request.headers.TTL).toBe("86400");
    expect(request.headers.Urgency).toBe("normal");
    expect(request.headers.Topic).toBeUndefined();
  });

  it("hashes a topic down to the 32 characters the spec allows", () => {
    const request = buildPushRequest({
      subscription: fakeSubscription(),
      payload: "{}",
      vapid,
      topic: "shift.cash_variance:0d5f8b1e-…-a-very-long-dedupe-key",
    });
    expect(request.headers.Topic).toHaveLength(32);
    expect(request.headers.Topic).toMatch(/^[\w-]{32}$/);
  });
});

describe("pushTopic", () => {
  it("is stable for the same key and different for another", () => {
    expect(pushTopic("a")).toBe(pushTopic("a"));
    expect(pushTopic("a")).not.toBe(pushTopic("b"));
  });
});

describe("classifyPushStatus", () => {
  it("treats 404/410 as a subscription that no longer exists", () => {
    expect(classifyPushStatus(404)).toBe("gone");
    expect(classifyPushStatus(410)).toBe("gone");
  });

  it("retries only what is worth retrying", () => {
    expect(classifyPushStatus(429)).toBe("retry");
    expect(classifyPushStatus(500)).toBe("retry");
    expect(classifyPushStatus(503)).toBe("retry");
    // Our own fault — the VAPID setup or the payload. Retrying changes nothing.
    expect(classifyPushStatus(400)).toBe("rejected");
    expect(classifyPushStatus(401)).toBe("rejected");
    expect(classifyPushStatus(403)).toBe("rejected");
  });

  it("accepts every 2xx", () => {
    expect(classifyPushStatus(200)).toBe("sent");
    expect(classifyPushStatus(201)).toBe("sent");
    expect(classifyPushStatus(202)).toBe("sent");
  });
});
