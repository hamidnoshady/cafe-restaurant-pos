/**
 * Phase 37 Wave 1 — database operations for platform-owned message config and
 * metered SMS/email credits.
 *
 * Mirrors Phase 18's AI platform billing (src/lib/ai-billing-service.ts): the
 * platform holds the provider relationship, the business never pastes a key,
 * and every balance is the SUM of a signed ledger — never a writable column.
 *
 * Three ownership rules govern the SQL:
 *   * Platform-wide configuration is a `platform_*` singleton administered in
 *     the console under `withoutTenantScope("platform", …)` — no tenant column.
 *   * A business's own balance/history/top-up is read and written in the
 *     current tenant scope, or under `withoutTenantScope` when the console is
 *     administering a *named* business across tenants.
 *   * The reservation contract (max-reserve → settle/refund) is the atomic one
 *     from `ai-billing-service.ts`, so two ticks cannot spend the same credit.
 */
import { randomUUID } from "node:crypto";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getPool, query, withTenant, withoutTenantScope, type PoolClient } from "./db";
import { getRealmSecret } from "./jwt-secret";
import type { CampaignChannel } from "./campaign-channels";
import type { MessageRate } from "./messaging-billing-pure";

export type MessageLedgerKind = "manual_grant" | "top_up" | "usage" | "usage_refund";

export type MessageTopUpStatus = "pending" | "approved" | "rejected";

export interface MessageResolvedConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  kavenegarApiKey: string | null;
  kavenegarSender: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string | null;
    from: string;
  } | null;
  rate: MessageRate;
  smtpConfigured: boolean;
  kavenegarConfigured: boolean;
  configured: boolean;
}

export interface MessagePublicConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  /** Whether each provider has usable credentials (never the credentials). */
  kavenegarConfigured: boolean;
  smtpConfigured: boolean;
  kavenegarSender: string;
  kavenegarKeyHint: string | null;
  smtpHost: string;
  smtpFrom: string;
  rate: MessageRate;
  configured: boolean;
  updatedAt: string | null;
}

export interface MessageSaveConfigInput {
  enabled?: boolean;
  smsProvider?: "kavenegar" | "noop";
  emailProvider?: "smtp" | "noop";
  kavenegarApiKey?: string | null;
  kavenegarSender?: string;
  clearKavenegarKey?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string | null;
  smtpFrom?: string;
  clearSmtpPassword?: boolean;
  smsRialPerSegment?: number;
  emailRialPerSend?: number;
}

export interface MessageBusinessBilling {
  balanceRial: number;
}

export interface MessageLedgerEntry {
  id: string;
  kind: MessageLedgerKind;
  amountRial: number;
  actualCostRial: number | null;
  note: string | null;
  createdAt: string;
}

export interface MessageTopUpRequest {
  id: string;
  businessId: string;
  businessName: string | null;
  packageId: string | null;
  packageName: string;
  priceRial: number;
  creditAmountRial: number;
  note: string | null;
  status: MessageTopUpStatus;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MessageSendReservation {
  requestId: string;
  reservedRial: number;
}

export class MessageInsufficientCreditError extends Error {
  constructor() {
    super("message_credit_required");
  }
}

export class MessageTopUpStateError extends Error {
  constructor() {
    super("top_up_not_pending");
  }
}

export class MessageConfigError extends Error {
  constructor(message = "message_provider_not_configured") {
    super(message);
  }
}

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function nonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Credential encryption (AES-256-GCM with the platform realm secret) — the
// same envelope as platform_sms_config.
// ---------------------------------------------------------------------------

function encryptCredential(plain: string, key: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptCredential(data: Buffer, key: Uint8Array): string | null {
  try {
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Platform message configuration
// ---------------------------------------------------------------------------

type ConfigRow = {
  enabled: boolean;
  sms_provider: string;
  email_provider: string;
  kavenegar_api_key_enc: Buffer | null;
  kavenegar_sender: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_password_enc: Buffer | null;
  smtp_from: string;
  sms_rial_per_segment: string | number;
  email_rial_per_send: string | number;
  updated_at: string | Date | null;
};

export async function resolveMessageConfig(): Promise<MessageResolvedConfig> {
  const row = await withoutTenantScope("platform", async () => {
    const { rows } = await query<ConfigRow>(
      `SELECT enabled, sms_provider, email_provider, kavenegar_api_key_enc,
              kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
              smtp_password_enc, smtp_from, sms_rial_per_segment,
              email_rial_per_send, updated_at
         FROM platform_message_config WHERE id = true`,
    );
    return rows[0];
  });

  const key = await getRealmSecret("platform");
  const base: Omit<MessageResolvedConfig, "configured"> = {
    enabled: row?.enabled ?? false,
    smsProvider: row?.sms_provider === "kavenegar" ? "kavenegar" : "noop",
    emailProvider: row?.email_provider === "smtp" ? "smtp" : "noop",
    kavenegarApiKey: row?.kavenegar_api_key_enc
      ? decryptCredential(row.kavenegar_api_key_enc, key)
      : null,
    kavenegarSender: row?.kavenegar_sender ?? "",
    smtp:
      row && (row.smtp_host || row.smtp_user || row.smtp_from)
        ? {
            host: row.smtp_host,
            port: row.smtp_port,
            secure: row.smtp_secure,
            user: row.smtp_user,
            password: row.smtp_password_enc
              ? decryptCredential(row.smtp_password_enc, key)
              : null,
            from: row.smtp_from,
          }
        : null,
    rate: {
      smsRialPerSegment: numberValue(row?.sms_rial_per_segment),
      emailRialPerSend: numberValue(row?.email_rial_per_send),
    },
    smtpConfigured: Boolean(
      row && row.smtp_host && row.smtp_from && (row.smtp_user || true) && row.smtp_password_enc,
    ),
    kavenegarConfigured: Boolean(row?.kavenegar_api_key_enc),
  };
  return {
    ...base,
    configured:
      base.enabled &&
      ((base.smsProvider === "noop" || base.kavenegarConfigured) &&
        (base.emailProvider === "noop" || base.smtpConfigured)),
  };
}

/** The effective provider credentials for sending, or throws when unusable. */
export async function requireMessageProviders(): Promise<MessageResolvedConfig> {
  const config = await resolveMessageConfig();
  if (!config.enabled) throw new MessageConfigError("message_disabled");
  if (config.smsProvider === "kavenegar" && !config.kavenegarApiKey) {
    throw new MessageConfigError("message_kavenegar_not_configured");
  }
  if (config.emailProvider === "smtp" && !config.smtpConfigured) {
    throw new MessageConfigError("message_smtp_not_configured");
  }
  return config;
}

export async function getPublicMessageConfig(): Promise<MessagePublicConfig> {
  const config = await resolveMessageConfig();
  const key = await getRealmSecret("platform");
  const kavenegarKey = config.kavenegarApiKey;
  return {
    enabled: config.enabled,
    smsProvider: config.smsProvider,
    emailProvider: config.emailProvider,
    kavenegarConfigured: config.kavenegarConfigured,
    smtpConfigured: config.smtpConfigured,
    kavenegarSender: config.kavenegarSender,
    kavenegarKeyHint: kavenegarKey ? `••••${kavenegarKey.slice(-4)}` : null,
    smtpHost: config.smtp?.host ?? "",
    smtpFrom: config.smtp?.from ?? "",
    rate: config.rate,
    configured: config.configured,
    updatedAt: null,
  };
}

export async function savePlatformMessageConfig(
  input: MessageSaveConfigInput,
): Promise<MessagePublicConfig> {
  const key = await getRealmSecret("platform");
  await withoutTenantScope("platform", async () => {
    const { rows } = await query<ConfigRow>(
      `SELECT enabled, sms_provider, email_provider, kavenegar_api_key_enc,
              kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
              smtp_password_enc, smtp_from, sms_rial_per_segment,
              email_rial_per_send, updated_at
         FROM platform_message_config WHERE id = true`,
    );
    const current = rows[0];
    const kavenegarKey =
      input.clearKavenegarKey === true
        ? null
        : typeof input.kavenegarApiKey === "string" && input.kavenegarApiKey.trim().length > 0
          ? encryptCredential(input.kavenegarApiKey.trim(), key)
          : current?.kavenegar_api_key_enc ?? null;
    const smtpPassword =
      input.clearSmtpPassword === true
        ? null
        : typeof input.smtpPassword === "string" && input.smtpPassword.trim().length > 0
          ? encryptCredential(input.smtpPassword.trim(), key)
          : current?.smtp_password_enc ?? null;

    if (!current) {
      await query(
        `INSERT INTO platform_message_config
           (id, enabled, sms_provider, email_provider, kavenegar_api_key_enc,
            kavenegar_sender, smtp_host, smtp_port, smtp_secure, smtp_user,
            smtp_password_enc, smtp_from, sms_rial_per_segment,
            email_rial_per_send, updated_at)
         VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())`,
        [
          input.enabled ?? false,
          input.smsProvider ?? "kavenegar",
          input.emailProvider ?? "smtp",
          kavenegarKey,
          input.kavenegarSender ?? "",
          input.smtpHost ?? "",
          input.smtpPort ?? 587,
          input.smtpSecure ?? false,
          input.smtpUser ?? "",
          smtpPassword,
          input.smtpFrom ?? "",
          input.smsRialPerSegment ?? 0,
          input.emailRialPerSend ?? 0,
        ],
      );
      return;
    }
    await query(
      `UPDATE platform_message_config
          SET enabled = $1, sms_provider = $2, email_provider = $3,
              kavenegar_api_key_enc = $4, kavenegar_sender = $5,
              smtp_host = $6, smtp_port = $7, smtp_secure = $8, smtp_user = $9,
              smtp_password_enc = $10, smtp_from = $11,
              sms_rial_per_segment = $12, email_rial_per_send = $13,
              updated_at = now()
        WHERE id = true`,
      [
        input.enabled ?? current.enabled,
        input.smsProvider ?? current.sms_provider,
        input.emailProvider ?? current.email_provider,
        kavenegarKey,
        input.kavenegarSender ?? current.kavenegar_sender,
        input.smtpHost ?? current.smtp_host,
        input.smtpPort ?? current.smtp_port,
        input.smtpSecure ?? current.smtp_secure,
        input.smtpUser ?? current.smtp_user,
        smtpPassword,
        input.smtpFrom ?? current.smtp_from,
        input.smsRialPerSegment ?? current.sms_rial_per_segment,
        input.emailRialPerSend ?? current.email_rial_per_send,
      ],
    );
  });
  return getPublicMessageConfig();
}

// ---------------------------------------------------------------------------
// Business billing, history and top-ups
// ---------------------------------------------------------------------------

export async function getMessageBusinessBilling(businessId: string): Promise<MessageBusinessBilling> {
  const { rows } = await query<{ balance_rial: string | null }>(
    `SELECT balance_rial FROM message_business_billing WHERE business_id = $1`,
    [businessId],
  );
  return { balanceRial: numberValue(rows[0]?.balance_rial) };
}

export async function listRecentMessageLedger(
  businessId: string,
  limit = 30,
): Promise<MessageLedgerEntry[]> {
  const { rows } = await query<{
    id: string;
    kind: MessageLedgerKind;
    amount_rial: string;
    actual_cost_rial: string | null;
    note: string | null;
    created_at: string;
  }>(
    `SELECT id, kind, amount_rial, actual_cost_rial, note, created_at
       FROM message_credit_ledger
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountRial: numberValue(r.amount_rial),
    actualCostRial: r.actual_cost_rial === null ? null : numberValue(r.actual_cost_rial),
    note: r.note,
    createdAt: r.created_at,
  }));
}

export async function createMessageTopUpRequest(input: {
  businessId: string;
  amountRial: number;
  note?: string;
}): Promise<MessageTopUpRequest> {
  if (!Number.isSafeInteger(input.amountRial) || input.amountRial <= 0) {
    throw new Error("invalid_amount");
  }
  const { rows } = await query<MessageTopUpRequestRow>(
    `INSERT INTO message_top_up_requests
       (business_id, package_id, package_name, price_rial, credit_amount_rial, note)
     VALUES ($1, NULL, 'مبلغ دلخواه', $2, $2, $3)
     RETURNING id, business_id, package_id, package_name, price_rial,
               credit_amount_rial, note, status, reviewed_at, created_at`,
    [input.businessId, input.amountRial, input.note?.trim() || null],
  );
  return toTopUpRequest(rows[0], null);
}

type MessageTopUpRequestRow = {
  id: string;
  business_id: string;
  package_id: string | null;
  package_name: string;
  price_rial: string;
  credit_amount_rial: string;
  note: string | null;
  status: MessageTopUpStatus;
  reviewed_at: string | null;
  created_at: string;
};

function toTopUpRequest(row: MessageTopUpRequestRow, businessName: string | null): MessageTopUpRequest {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName,
    packageId: row.package_id,
    packageName: row.package_name,
    priceRial: numberValue(row.price_rial),
    creditAmountRial: numberValue(row.credit_amount_rial),
    note: row.note,
    status: row.status,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

export async function reviewMessageTopUpRequest(input: {
  requestId: string;
  status: "approved" | "rejected";
  platformAdminId: string;
}): Promise<MessageTopUpRequest> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows: requestRows } = await client.query<MessageTopUpRequestRow>(
        `SELECT id, business_id, package_id, package_name, price_rial,
                credit_amount_rial, note, status, reviewed_at, created_at
           FROM message_top_up_requests
          WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const request = requestRows[0];
      if (!request) throw new Error("not_found");
      if (request.status !== "pending") throw new MessageTopUpStateError();

      let ledgerId: string | null = null;
      if (input.status === "approved") {
        ledgerId = await grantMessageCreditInTransaction(client, {
          businessId: request.business_id,
          amountRial: numberValue(request.credit_amount_rial),
          kind: "top_up",
          note: `تأیید شارژ «${request.package_name}»`,
          platformAdminId: input.platformAdminId,
        });
      }
      const { rows: updated } = await client.query<MessageTopUpRequestRow>(
        `UPDATE message_top_up_requests
            SET status = $2, reviewed_by = $3, reviewed_at = now(), fulfilled_ledger_id = $4
          WHERE id = $1
          RETURNING id, business_id, package_id, package_name, price_rial,
                    credit_amount_rial, note, status, reviewed_at, created_at`,
        [input.requestId, input.status, input.platformAdminId, ledgerId],
      );
      await client.query("COMMIT");
      return toTopUpRequest(updated[0], null);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

export async function listPlatformMessageTopUpRequests(
  pendingOnly = false,
): Promise<MessageTopUpRequest[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<MessageTopUpRequestRow & { business_name: string }>(
      `SELECT r.id, r.business_id, b.name AS business_name, r.package_id, r.package_name,
              r.price_rial, r.credit_amount_rial, r.note, r.status, r.reviewed_at, r.created_at
         FROM message_top_up_requests r
         JOIN businesses b ON b.id = r.business_id
        WHERE ($1::boolean = false OR r.status = 'pending')
        ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END, r.created_at DESC
        LIMIT 200`,
      [pendingOnly],
    );
    return rows.map((r) => toTopUpRequest(r, r.business_name));
  });
}

async function grantMessageCreditInTransaction(
  client: PoolClient,
  input: {
    businessId: string;
    amountRial: number;
    kind: MessageLedgerKind;
    note: string | null;
    createdByUserId?: string | null;
    platformAdminId?: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ business_id: string }>(
    `INSERT INTO message_business_billing (business_id, balance_rial)
     VALUES ($1, $2)
     ON CONFLICT (business_id)
       DO UPDATE SET balance_rial = message_business_billing.balance_rial + $2, updated_at = now()
     RETURNING business_id`,
    [input.businessId, input.amountRial],
  );
  await client.query(
    `INSERT INTO message_credit_ledger
       (business_id, kind, amount_rial, note, created_by_user_id, platform_admin_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.businessId,
      input.kind,
      input.amountRial,
      input.note,
      input.createdByUserId ?? null,
      input.platformAdminId ?? null,
    ],
  );
  return rows[0]?.business_id ?? input.businessId;
}

// ---------------------------------------------------------------------------
// Reserve → settle → refund. The atomic contract, identical to ai-billing.
// ---------------------------------------------------------------------------

/**
 * Reserves `reservedRial` up-front. Throws MessageInsufficientCreditError when
 * the business cannot cover it, before any send attempt (Wave 1 exit #5).
 */
export async function reserveMessageSend(input: {
  businessId: string;
  reservedRial: number;
  userId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<MessageSendReservation> {
  if (!Number.isSafeInteger(input.reservedRial) || input.reservedRial <= 0) {
    throw new MessageInsufficientCreditError();
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ balance_rial: string }>(
      `SELECT balance_rial FROM message_business_billing
        WHERE business_id = $1 FOR UPDATE`,
      [input.businessId],
    );
    const balance = numberValue(rows[0]?.balance_rial);
    if (balance < input.reservedRial) {
      await client.query("ROLLBACK");
      throw new MessageInsufficientCreditError();
    }
    const requestId = randomUUID();
    await client.query(
      `UPDATE message_business_billing
          SET balance_rial = balance_rial - $2, updated_at = now()
        WHERE business_id = $1`,
      [input.businessId, input.reservedRial],
    );
    await client.query(
      `INSERT INTO message_credit_ledger
         (business_id, kind, amount_rial, request_id, created_by_user_id, metadata)
       VALUES ($1, 'usage', $2, $3, $4, $5::jsonb)`,
      [
        input.businessId,
        -input.reservedRial,
        requestId,
        input.userId ?? null,
        JSON.stringify({ ...input.metadata, reservedRial: input.reservedRial, phase: "reserved" }),
      ],
    );
    await client.query("COMMIT");
    return { requestId, reservedRial: input.reservedRial };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Settles a reservation against the cost that actually went out (Wave 4's
 * "cost at real-send time, per what actually went"). Returns the refunded
 * remainder so the caller can post exactly what was spent.
 */
export async function settleMessageSend(input: {
  businessId: string;
  reservation: MessageSendReservation;
  actualCostRial: number;
  note?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ chargedRial: number; refundedRial: number }> {
  const chargedRial = Math.max(0, Math.min(input.actualCostRial, input.reservation.reservedRial));
  const refundedRial = input.reservation.reservedRial - chargedRial;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE message_credit_ledger
          SET actual_cost_rial = $3, note = $4,
              metadata = metadata || $5::jsonb
        WHERE business_id = $1 AND request_id = $2 AND kind = 'usage'
        RETURNING id`,
      [
        input.businessId,
        input.reservation.requestId,
        chargedRial,
        input.note ?? null,
        JSON.stringify({ actualCostRial: chargedRial, phase: "settled", ...input.metadata }),
      ],
    );
    if (!rows[0]) throw new Error("message_reservation_not_found");
    if (refundedRial > 0) {
      await client.query(
        `UPDATE message_business_billing
            SET balance_rial = balance_rial + $2, updated_at = now()
          WHERE business_id = $1`,
        [input.businessId, refundedRial],
      );
      await client.query(
        `INSERT INTO message_credit_ledger
           (business_id, kind, amount_rial, request_id, metadata)
         VALUES ($1, 'usage_refund', $2, $3, $4::jsonb)`,
        [
          input.businessId,
          refundedRial,
          input.reservation.requestId,
          JSON.stringify({ reservedRial: input.reservation.reservedRial, actualCostRial: chargedRial }),
        ],
      );
    }
    await client.query("COMMIT");
    return { chargedRial, refundedRial };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refunds an untouched reservation in full — used when a send never happened
 * (a provider outage or a campaign paused before it went out). Exactly the
 * "unsent messages return their credit" path of Wave 2 exit #6.
 */
export async function refundUnsentMessage(input: {
  businessId: string;
  reservation: MessageSendReservation;
  reason: string;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE message_credit_ledger
          SET metadata = metadata || $3::jsonb
        WHERE business_id = $1 AND request_id = $2 AND kind = 'usage'
        RETURNING id`,
      [
        input.businessId,
        input.reservation.requestId,
        JSON.stringify({ phase: "refunded", reason: input.reason }),
      ],
    );
    if (rows[0]) {
      await client.query(
        `UPDATE message_business_billing
            SET balance_rial = balance_rial + $2, updated_at = now()
          WHERE business_id = $1`,
        [input.businessId, input.reservation.reservedRial],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Convenience: settle a reservation at a channel's exact rendered cost. */
export async function settleMessageAtCost(input: {
  businessId: string;
  reservation: MessageSendReservation;
  channel: CampaignChannel;
  body: string;
  rate: MessageRate;
  note?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ chargedRial: number; refundedRial: number }> {
  // Imported lazily to avoid a cycle at module load (both are cheap pure fns).
  const { messageCostRial } = await import("./messaging-billing-pure");
  return settleMessageSend({
    businessId: input.businessId,
    reservation: input.reservation,
    actualCostRial: messageCostRial(input.channel, input.body, input.rate),
    note: input.note,
    metadata: input.metadata,
  });
}

/**
 * Background tick used by Wave 1 exit #4's guarantee that a balance is always
 * a ledger SUM. Reads each business's true balance directly from the ledger so
 * a drift between the mirrored column and the SUM cannot hide forever.
 */
export async function getMessageLedgerBalance(businessId: string): Promise<number> {
  const { rows } = await query<{ balance_rial: string | null }>(
    `SELECT sum(amount_rial) AS balance_rial FROM message_credit_ledger WHERE business_id = $1`,
    [businessId],
  );
  return numberValue(rows[0]?.balance_rial);
}

/** per-business helper used by the outbox tick to settle a whole campaign. */
export async function withTenantMessageBalance<T>(
  businessId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant(businessId, fn);
}
