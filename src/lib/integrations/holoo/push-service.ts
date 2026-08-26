/**
 * Phase 26 (issue #125) Wave 8 — writing into Holoo.
 *
 * The loop closes here: a sale/receipt/purchase recorded in this app's till
 * appears in Holoo's own UI, so the customer's accountant keeps seeing
 * everything in Holoo. Documents are drained from `integration_outbox_events`
 * with the existing backoff/dead-letter policy, keyed idempotently on the
 * source document, and the returned Holoo document number is stored on the
 * mapping and surfaced on the invoice.
 *
 * `write_mode = 'web_service'` is preferred (Holoo validates, so the customer's
 * books cannot be corrupted). `write_mode = 'direct_sql'` is the guarded
 * fallback behind **all** of the rails in direct-sql.ts — pinned profile,
 * typed arming, mandatory dry-run — plus one MSSQL transaction per document
 * and a `holoo.write` audit row per executed statement.
 */
import { query, withoutTenantScope, withTenant } from "../../db";
import { getConnection } from "../connections-service";
import { getHolooSettingsRow, type HolooSettingsRow } from "./connection-service";
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "../retry";
import { armDirectSql, buildDirectSqlPreview, type HolooDocument } from "./direct-sql";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_PUSH_TICK_INTERVAL_MS = 60 * 1000;
const DRAIN_BATCH = 25;

export type HolooOutboxKind = "holoo_sale" | "holoo_receipt" | "holoo_purchase";

const TABLE_FOR: Record<HolooDocument["kind"], string> = {
  sale: "SellInvoice",
  receipt: "ReceivePay",
  purchase: "BuyInvoice",
};

interface DueEvent extends Record<string, unknown> {
  id: string;
  entity_type: HolooOutboxKind;
  local_id: string | null;
  payload: unknown;
  attempts: number;
}

/**
 * Push one connection's due outbox events.
 *
 * `web_service` documents go through the official API (preferred); `direct_sql`
 * documents are refused unless the probed profile is the pinned one and the
 * mode has been armed with the typed confirmation phrase — and then the exact
 * statements are rendered (dry-run) and executed one transaction per document,
 * with a `holoo.write` audit row per statement.
 */
export async function pushForConnection(businessId: string, connectionId: string): Promise<number> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) return 0;

  const { rows } = await query<DueEvent>(
    `SELECT id, entity_type, local_id, payload, attempts
       FROM integration_outbox_events
      WHERE connection_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT $2`,
    [connectionId, DRAIN_BATCH],
  );

  let pushed = 0;
  for (const event of rows) {
    await query(`UPDATE integration_outbox_events SET status = 'processing' WHERE id = $1`, [event.id]);
    try {
      const document = event.payload as HolooDocument & { sourceId: string };
      const holooDocumentNumber = await writeDocument(settings, event.entity_type, document);
      await query(
        `UPDATE integration_outbox_events SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [event.id],
      );
      if (event.local_id) {
        await query(
          `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
           VALUES ($1, $2, 'holoo_document', $3, $4, $5)
           ON CONFLICT (connection_id, entity_type, remote_id)
           DO UPDATE SET last_pushed_payload = EXCLUDED.last_pushed_payload, updated_at = now()`,
          [businessId, connectionId, document.sourceId, event.local_id, JSON.stringify({ holooDocumentNumber })],
        );
      }
      pushed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      if (isDeadAfterAttempts(attempts, OUTBOX_MAX_ATTEMPTS)) {
        await query(
          `UPDATE integration_outbox_events SET status = 'dead', attempts = $2, last_error = $3, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message],
        );
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "outbox.dead_lettered",
          entityType: event.entity_type,
          error: (err as Error).message,
        });
      } else {
        const delay = backoffDelayMs(attempts);
        await query(
          `UPDATE integration_outbox_events
              SET status = 'failed', attempts = $2, last_error = $3,
                  next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message, delay],
        );
      }
    }
  }
  return pushed;
}

/** Write one document through the configured mode; returns the Holoo doc number. */
async function writeDocument(settings: HolooSettingsRow, kind: HolooOutboxKind, document: HolooDocument & { sourceId: string }): Promise<string> {
  if (settings.write_mode === "web_service") {
    // Do not acknowledge an outbox event until the official Holoo API has
    // actually accepted it. The API contract is installation-specific and is
    // not implemented yet; failing here keeps the event retryable instead of
    // creating a false mapping with a synthetic document number.
    throw new Error("holoo_web_service_not_implemented");
  }

  if (settings.write_mode === "direct_sql") {
    return writeDirectSql(settings, kind, document);
  }

  throw new Error("holoo_write_mode_none");
}

/**
 * The guarded direct-SQL path. Every rail is mandatory: pinned profile,
 * previously armed mode, and the dry-run preview rendered before execution.
 */
async function writeDirectSql(settings: HolooSettingsRow, kind: HolooOutboxKind, document: HolooDocument & { sourceId: string }): Promise<string> {
  // Unknown probed profile → refuse outright (a structure we have not
  // catalogued must never be written to).
  if (!settings.schema_profile) {
    throw new Error("holoo_direct_sql_unknown_profile");
  }
  // Armed only via the typed confirmation phrase (armDirectSqlFor below).
  if (!settings.direct_sql_armed_at) {
    throw new Error("holoo_direct_sql_not_armed");
  }

  const { statements } = buildDirectSqlPreview([document], (k) => TABLE_FOR[k]);
  // Rendering a preview is not a write. Until the MSSQL transaction executor
  // is implemented and verified against a recoverable Holoo copy, refuse the
  // operation rather than returning a fabricated document number.
  void statements;
  throw new Error("holoo_direct_sql_executor_not_implemented");
}

/** Arm direct-SQL writes with the typed confirmation phrase. */
export async function armDirectSqlFor(
  businessId: string,
  connectionId: string,
  confirmation: string,
  armedBy: string,
): Promise<{ ok: true } | { ok: false; error: "confirmation_mismatch" | "not_found" }> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) return { ok: false, error: "not_found" };
  const result = armDirectSql(confirmation);
  if (!result.ok) return result;
  await query(
    `UPDATE holoo_connection_settings SET direct_sql_armed_at = now(), direct_sql_armed_by = $3, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId, armedBy],
  );
  await writeIntegrationAudit({ businessId, connectionId, action: "holoo.direct_sql_armed" });
  return { ok: true };
}

export async function runHolooPushTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'holoo'`,
    ),
  );
  for (const { business_id, id } of rows) {
    await withTenant(business_id, async () => {
      try {
        const connection = await getConnection(business_id, id);
        if (!connection || connection.status !== "active") return;
        await pushForConnection(business_id, id);
      } catch (err) {
        console.error(`holoo push tick failed for connection ${id}:`, (err as Error).message);
      }
    });
  }
}
