import { query } from "../../db";
import { decryptSecret, resolveEncryptionKey } from "../../integrations/secrets";
import {
  LEGACY_KEY_HEADER,
  LEGACY_NONCE_HEADER,
  LEGACY_SIGNATURE_HEADER,
  LEGACY_TIMESTAMP_HEADER,
  verifyLegacyUsageSignature,
} from "./compat/legacy-nonce-body-hash";
import {
  BILLING_KEY_HEADER,
  BILLING_SIGNATURE_HEADER,
  BILLING_TIMESTAMP_HEADER,
  billingBodyFingerprint,
  type BillingServiceScope,
  verifyBillingBodySignature,
} from "./sign";

export interface BillingServiceHeaders {
  keyId: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}

export function readBillingServiceHeaders(
  request: Request,
): Omit<BillingServiceHeaders, "rawBody"> & { nonce?: string; legacy: boolean } {
  const keyId = request.headers.get(BILLING_KEY_HEADER) ?? request.headers.get(LEGACY_KEY_HEADER) ?? "";
  const timestamp = request.headers.get(BILLING_TIMESTAMP_HEADER) ?? request.headers.get(LEGACY_TIMESTAMP_HEADER) ?? "";
  const signature = request.headers.get(BILLING_SIGNATURE_HEADER) ?? request.headers.get(LEGACY_SIGNATURE_HEADER) ?? "";
  const nonce = request.headers.get(LEGACY_NONCE_HEADER) ?? undefined;
  const legacy = !request.headers.get(BILLING_KEY_HEADER) && Boolean(request.headers.get(LEGACY_KEY_HEADER));
  return { keyId, timestamp, signature, nonce, legacy };
}

async function loadCredential(keyId: string, scope: BillingServiceScope): Promise<string | null> {
  const { rows } = await query<{ secret_enc: string; scope: string }>(
    `SELECT secret_enc, scope FROM billing_service_credentials
      WHERE key_id = $1 AND revoked_at IS NULL`,
    [keyId],
  );
  const row = rows[0];
  if (!row || row.scope !== scope) return null;
  try {
    return decryptSecret(row.secret_enc, resolveEncryptionKey(process.env));
  } catch {
    return null;
  }
}

async function recordReplay(keyId: string, fingerprint: string): Promise<boolean> {
  const inserted = await query<{ fingerprint: string }>(
    `INSERT INTO billing_service_replays (key_id, fingerprint) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING fingerprint`,
    [keyId, fingerprint],
  );
  return Boolean(inserted.rows[0]);
}

async function recordLegacyNonce(keyId: string, nonce: string): Promise<boolean> {
  const inserted = await query<{ nonce: string }>(
    `INSERT INTO billing_service_nonces (key_id, nonce) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING nonce`,
    [keyId, nonce],
  );
  return Boolean(inserted.rows[0]);
}

/** Verify a CMS billing request (billing-contract/v1 headers). */
export async function verifyBillingServiceRequest(
  input: BillingServiceHeaders & { nonce?: string; legacy?: boolean },
  scope: BillingServiceScope = "billing.usage.write",
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!input.keyId) return { ok: false, code: "UNKNOWN_KEY" };
  const secret = await loadCredential(input.keyId, scope);
  if (!secret) return { ok: false, code: "UNKNOWN_KEY" };

  if (input.legacy) {
    const verified = verifyLegacyUsageSignature({
      body: input.rawBody,
      nonce: input.nonce ?? null,
      secret,
      signature: input.signature,
      timestampMs: input.timestamp,
    });
    if (!verified.ok) {
      return {
        ok: false,
        code: verified.reason === "expired" ? "STALE_TIMESTAMP" : "BAD_SIGNATURE",
      };
    }
    const seen = await recordLegacyNonce(input.keyId, verified.nonce);
    if (!seen) return { ok: false, code: "REPLAY" };
    return { ok: true };
  }

  const verified = verifyBillingBodySignature({
    secret,
    timestamp: input.timestamp,
    signature: input.signature,
    rawBody: input.rawBody,
  });
  if (!verified.ok) return verified;

  const fingerprint = `${input.keyId}:${billingBodyFingerprint(input.timestamp.trim(), input.rawBody)}`;
  const fresh = await recordReplay(input.keyId, fingerprint);
  if (!fresh) return { ok: false, code: "REPLAY" };
  return { ok: true };
}
