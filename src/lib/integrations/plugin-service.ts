/**
 * The app's half of the WordPress plugin link: authenticating the plugin,
 * accepting the events it pushes, and handing it the work it should apply.
 *
 * DB-touching, so no direct unit test per repo convention — the envelope
 * verification it rests on is pure and covered by `plugin-link.test.ts`, and
 * everything an event does downstream is the *same* code the REST/webhook path
 * already runs (`webhook-ingest-service.ts`). That reuse is the point: a store
 * connected by plugin and a store connected by consumer keys produce
 * byte-identical orders, payments and journal entries, because there is one
 * ingest path and this is only a second door into it.
 *
 * ## Direction of travel
 *
 * REST mode: the app calls the store (outbound), the store calls the app
 * (webhooks, inbound). Both directions need the store to be reachable from the
 * internet and the app to hold the store's master credentials.
 *
 * Plugin mode: the plugin calls the app, always — pushing events it saw, and
 * pulling jobs to apply. The app never dials out. A store behind a firewall,
 * on a host that blocks incoming webhooks, or with no fixed address works
 * unchanged, and the only credential in this database is a token that grants
 * exactly this.
 */
import { NextResponse } from "next/server";
import { query, withoutTenantScope, withTenant } from "../db";
import { isFeatureEnabled } from "../features";
import { writeIntegrationAudit } from "./audit";
import {
  CONNECTION_COLUMNS,
  linkTokenFor,
  type ConnectionRow,
} from "./connections-service";
import {
  PLUGIN_NONCE_HEADER,
  PLUGIN_SIGNATURE_HEADER,
  PLUGIN_TIMESTAMP_HEADER,
  PLUGIN_TIMESTAMP_SKEW_MS,
  hashPluginToken,
  verifyPluginEnvelope,
} from "./plugin-link";
import { ingestPluginEvent, type PluginEventInput } from "./webhook-ingest-service";

/** How many jobs one pull may lease. Bounded so a WP-Cron run finishes inside PHP's time limit. */
const JOB_PULL_LIMIT = 25;
/** How long a leased job stays invisible to a second concurrent pull. */
const JOB_LEASE_MS = 5 * 60 * 1000;
/** Cap on one push, so a compromised or looping plugin cannot submit unbounded work in one request. */
const MAX_EVENTS_PER_PUSH = 100;

/**
 * Resolve and verify one inbound plugin request.
 *
 * The token lookup runs inside the documented `woocommerce-plugin-auth`
 * bypass, because resolving a credential to its tenant is exactly what that
 * bypass is for — and the HMAC check runs inside it too, since the token the
 * signature is verified against is what the lookup returns. Everything after
 * authentication runs in the resolved business's own scope.
 *
 * The nonce is recorded *inside* the tenant scope and its insert is what
 * decides replay: `integration_plugin_nonces`' primary key makes a second use
 * of the same nonce a conflict rather than a race between a read and a write.
 */
export async function authenticatePlugin(
  headers: Headers,
  rawBody: string,
): Promise<{ ok: true; connection: ConnectionRow; nonce: string } | { ok: false; error: string; status: number }> {
  const authorization = headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!token) return { ok: false, error: "missing_token", status: 401 };

  const connection = await withoutTenantScope("woocommerce-plugin-auth", async () => {
    const { rows } = await query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE link_token_hash = $1`,
      [hashPluginToken(token)],
    );
    return rows[0] ?? null;
  });
  // Deliberately the same answer as a bad signature would give: an
  // unauthenticated caller learns whether their credential works, never
  // whether a given token exists but is misconfigured.
  if (!connection || connection.link_mode !== "plugin") {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  // The stored token, decrypted — not the one the caller presented. Verifying
  // the HMAC against the caller's own copy would make the signature prove
  // nothing at all.
  const secret = linkTokenFor(connection);
  if (!secret) return { ok: false, error: "unauthorized", status: 401 };

  const verified = verifyPluginEnvelope(
    secret,
    {
      signature: headers.get(PLUGIN_SIGNATURE_HEADER),
      timestamp: headers.get(PLUGIN_TIMESTAMP_HEADER),
      nonce: headers.get(PLUGIN_NONCE_HEADER),
    },
    rawBody,
    Date.now(),
  );
  if (!verified.ok) {
    return { ok: false, error: verified.error, status: 401 };
  }

  return withTenant(connection.business_id, async () => {
    if (!(await isFeatureEnabled(connection.business_id, "integrations"))) {
      return { ok: false as const, error: "feature_disabled", status: 403 };
    }

    const { rowCount } = await query(
      `INSERT INTO integration_plugin_nonces (business_id, connection_id, nonce)
       VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, nonce) DO NOTHING`,
      [connection.business_id, connection.id, verified.envelope.nonce],
    );
    if ((rowCount ?? 0) === 0) return { ok: false as const, error: "replayed_nonce", status: 401 };

    // Opportunistic sweep: a nonce older than the freshness window can never
    // authenticate again, so keeping it protects nothing. Cheap because
    // `seen_at` is indexed, and doing it here rather than on a timer means the
    // table is bounded by traffic that actually happens.
    await query(
      `DELETE FROM integration_plugin_nonces
        WHERE connection_id = $1 AND seen_at < now() - ($2 || ' milliseconds')::interval`,
      [connection.id, PLUGIN_TIMESTAMP_SKEW_MS * 2],
    );

    await query(
      `UPDATE integration_connections SET last_plugin_seen_at = now() WHERE id = $1 AND business_id = $2`,
      [connection.id, connection.business_id],
    );

    return { ok: true as const, connection, nonce: verified.envelope.nonce };
  });
}

/**
 * Everything the plugin needs to configure itself, and everything the app
 * knows about the plugin — exchanged on every handshake so neither side has to
 * be told twice when a setting changes.
 */
export interface PluginHandshakeInput {
  siteUrl?: string;
  pluginVersion?: string;
}

export async function pluginHandshake(
  connection: ConnectionRow,
  input: PluginHandshakeInput,
): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    const siteUrl = input.siteUrl?.trim().slice(0, 500) || null;
    const version = input.pluginVersion?.trim().slice(0, 40) || null;
    await query(
      `UPDATE integration_connections
          SET plugin_site_url = COALESCE($3, plugin_site_url),
              plugin_version = COALESCE($4, plugin_version),
              status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
              last_error = NULL,
              last_plugin_seen_at = now(),
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [connection.id, connection.business_id, siteUrl, version],
    );
    await writeIntegrationAudit({
      businessId: connection.business_id,
      connectionId: connection.id,
      action: "plugin.handshake",
      payload: { siteUrl, version },
    });

    return NextResponse.json({
      ok: true,
      connection: {
        id: connection.id,
        name: connection.name,
        currencyUnit: connection.currency_unit,
        // The plugin mirrors these switches so it does not push events the app
        // would only discard, and does not apply jobs the owner turned off.
        syncOrders: connection.sync_orders,
        syncProducts: connection.sync_products,
        syncCustomers: connection.sync_customers,
        pushStock: connection.push_stock,
        pushPrices: connection.push_prices,
        status: connection.status,
      },
      // Everything time-sensitive about the protocol, so the plugin never has
      // to hardcode a constant this side owns.
      protocol: { version: 1, timestampSkewMs: PLUGIN_TIMESTAMP_SKEW_MS, jobPullLimit: JOB_PULL_LIMIT },
    });
  });
}

export interface PluginEventsInput {
  events?: PluginEventInput[];
}

/**
 * Accept a batch of events the plugin observed in WordPress.
 *
 * Each is dedup'd and applied by the shared ingest path, so a plugin that
 * re-sends after a timeout — the normal case, since WP-Cron cannot know
 * whether a request that died mid-flight was applied — costs nothing.
 * Per-event results come back individually: one malformed order must not
 * force the plugin to re-send a batch of ninety-nine good ones.
 */
export async function pluginPushEvents(
  connection: ConnectionRow,
  input: PluginEventsInput,
): Promise<NextResponse> {
  const events = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_PUSH) : [];
  if (events.length === 0) return NextResponse.json({ ok: true, results: [] });

  return withTenant(connection.business_id, async () => {
    const results: { deliveryId: string; status: string; error?: string }[] = [];
    for (const event of events) {
      results.push(await ingestPluginEvent(connection, event));
    }
    // Real inbound sync: the plugin delivered a batch, so "آخرین همگام‌سازی"
    // has something true to show. Only the REST-mode paths write last_sync_at
    // today; without this, plugin-mode connections stay "—" forever even
    // while orders and products keep arriving.
    await query(
      `UPDATE integration_connections SET last_sync_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [connection.id, connection.business_id],
    );
    return NextResponse.json({ ok: true, results });
  });
}

export interface PluginJob {
  id: string;
  type: string;
  remoteId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Lease the jobs this plugin should apply next.
 *
 * These are `integration_outbox_events` rows — the same queue, with the same
 * retry and dead-letter state, that the REST path drains by calling the store.
 * The only difference is who does the calling. Leasing (rather than simply
 * reading) is what keeps two overlapping WP-Cron runs from both applying the
 * same stock update; an un-acked lease expires and the job comes back, so a
 * plugin that dies mid-run loses nothing.
 */
export async function pluginPullJobs(connection: ConnectionRow): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    const { rows } = await query<{
      id: string;
      entity_type: string;
      remote_id: string;
      payload: Record<string, unknown>;
      attempts: number;
    }>(
      `UPDATE integration_outbox_events
          SET status = 'processing', leased_until = now() + ($3 || ' milliseconds')::interval, updated_at = now()
        WHERE id IN (
          SELECT id FROM integration_outbox_events
           WHERE connection_id = $1
             AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= now())
               OR (status = 'processing' AND leased_until IS NOT NULL AND leased_until < now())
             )
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, entity_type, remote_id, payload, attempts`,
      [connection.id, JOB_PULL_LIMIT, JOB_LEASE_MS],
    );

    const jobs: PluginJob[] = rows.map((row) => ({
      id: row.id,
      type: row.entity_type,
      remoteId: row.remote_id,
      payload: row.payload,
      attempts: row.attempts,
    }));
    return NextResponse.json({ ok: true, jobs });
  });
}

export interface PluginJobAck {
  id: string;
  status: "done" | "failed";
  error?: string;
}

/** How many times a job is retried before it is dead-lettered. Mirrors the REST drain's own cap. */
const JOB_MAX_ATTEMPTS = 6;
/** Exponential, capped — same shape as `retry.ts`'s backoff, expressed in the SQL below. */
const JOB_BASE_BACKOFF_MS = 30_000;

export async function pluginAckJobs(
  connection: ConnectionRow,
  results: PluginJobAck[],
): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    let done = 0;
    let failed = 0;
    for (const result of Array.isArray(results) ? results.slice(0, JOB_PULL_LIMIT) : []) {
      if (!result?.id) continue;
      if (result.status === "done") {
        const { rowCount } = await query(
          `UPDATE integration_outbox_events
              SET status = 'sent', sent_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()
            WHERE id = $1 AND connection_id = $2`,
          [result.id, connection.id],
        );
        done += rowCount ?? 0;
        continue;
      }

      const message = (result.error ?? "plugin_failed").slice(0, 500);
      const { rows } = await query<{ attempts: number; status: string }>(
        `UPDATE integration_outbox_events
            SET attempts = attempts + 1,
                last_error = $3,
                leased_until = NULL,
                status = CASE WHEN attempts + 1 >= $4 THEN 'dead' ELSE 'failed' END,
                next_attempt_at = now() + (LEAST(POWER(2, attempts) * $5, 3600000) || ' milliseconds')::interval,
                updated_at = now()
          WHERE id = $1 AND connection_id = $2
        RETURNING attempts, status`,
        [result.id, connection.id, message, JOB_MAX_ATTEMPTS, JOB_BASE_BACKOFF_MS],
      );
      failed += rows.length;
      if (rows[0]?.status === "dead") {
        await writeIntegrationAudit({
          businessId: connection.business_id,
          connectionId: connection.id,
          action: "outbox.dead_lettered",
          error: message,
        });
      }
    }
    // Outbound sync happened: the plugin applied at least one leased job, so
    // mark the connection as having synced (see pluginPushEvents for why).
    if (done + failed > 0) {
      await query(
        `UPDATE integration_connections SET last_sync_at = now(), updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [connection.id, connection.business_id],
      );
    }
    return NextResponse.json({ ok: true, done, failed });
  });
}

/**
 * Ask the plugin, next time it pulls, to send everything of one kind.
 *
 * This is how "sync products now" works in plugin mode: the app cannot read
 * the store, so the button enqueues a job and the catalogue arrives as ordinary
 * events. Upserted on `(connection_id, entity_type, remote_id)` — pressing the
 * button twice before the plugin next runs refreshes one job rather than
 * queueing two full exports.
 */
export async function enqueuePluginExport(
  businessId: string,
  connectionId: string,
  entityType: "catalogue_export" | "customer_export",
): Promise<void> {
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, $3, 'all', '{}'::jsonb)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = now(),
                   last_error = NULL, leased_until = NULL, updated_at = now()`,
    [businessId, connectionId, entityType],
  );
}
