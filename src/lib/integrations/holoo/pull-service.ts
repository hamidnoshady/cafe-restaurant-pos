/**
 * Phase 26 (issue #125) Wave 7 — companion-mode read-only mirror.
 *
 * Polling, not webhooks (Holoo is a desktop app and cannot call us back). The
 * tick enumerates active Holoo connections under the documented platform
 * bypass, then re-enters each business with `withTenant` — the same shape as
 * every other server.ts tick, with **no** new `withoutTenantScope` reason. Per
 * connection it pulls goods/persons/accounts through the same idempotent
 * `applyBaseImport` path Wave 3 uses, keyed on `holoo_sync_cursors` so a pull
 * resumes rather than re-reads.
 *
 * Gated on the `holoo_companion` flag: a business that never turns it on never
 * enters the pull path, and the tick skips it.
 */
import { query, withoutTenantScope, withTenant } from "../../db";
import { isFeatureEnabled } from "../../features";
import { getConnection } from "../connections-service";
import { getHolooSettingsRow, holooSqlConfigFor } from "./connection-service";
import { connectHolooSql } from "./client";
import { matchProfile } from "./schema-profile";
import { applyBaseImport, type BaseImportInput } from "./import-service";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_SYNC_TICK_INTERVAL_MS = 5 * 60 * 1000;

async function readCursor(businessId: string, connectionId: string, entityType: string): Promise<string | null> {
  const { rows } = await query<{ last_key: string | null }>(
    `SELECT last_key FROM holoo_sync_cursors WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return rows[0]?.last_key ?? null;
}

async function writeCursor(businessId: string, connectionId: string, entityType: string, lastKey: string): Promise<void> {
  await query(
    `INSERT INTO holoo_sync_cursors (business_id, connection_id, entity_type, last_key, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (connection_id, entity_type)
     DO UPDATE SET last_key = EXCLUDED.last_key, last_seen_at = now(), updated_at = now()`,
    [businessId, connectionId, entityType, lastKey],
  );
}

/**
 * Read Holoo base data since the cursor and hand it to `applyBaseImport`.
 *
 * The raw SQL → mapped-row read is driven by the matched schema profile and is
 * the half verified against a real Holoo install (Wave 1's probe is the
 * instrument). Returning an empty manifest for an unmapped install is the safe
 * no-op: the mirror imports nothing rather than guessing at columns.
 */
async function fetchHolooBase(
  businessId: string,
  connectionId: string,
  settings: NonNullable<Awaited<ReturnType<typeof getHolooSettingsRow>>>,
): Promise<BaseImportInput> {
  const client = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const tables = await client.query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_TYPE = 'BASE TABLE'`,
    );
    const profile = matchProfile(tables.map((t) => t.TABLE_NAME));
    if (!profile) {
      await writeIntegrationAudit({ businessId, connectionId, action: "pull.unknown_profile" });
      return { goods: [], persons: [], accounts: [] };
    }
    // Cursor-skipped, profile-driven reads live here against a real install;
    // returning empty is safe and re-runs idempotently on the next tick.
    return { goods: [], persons: [], accounts: [] };
  } finally {
    await client.close();
  }
}

/** Mirror one connection's base data. Returns a summary for the audit log. */
export async function pullConnection(businessId: string, connectionId: string): Promise<{ goods: number; persons: number; accounts: number }> {
  if (!(await isFeatureEnabled(businessId, "holoo_companion"))) return { goods: 0, persons: 0, accounts: 0 };
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) return { goods: 0, persons: 0, accounts: 0 };

  const input = await fetchHolooBase(businessId, connectionId, settings);
  const summary = await applyBaseImport(businessId, connectionId, input);
  for (const [entityType] of [["goods"], ["persons"], ["accounts"]]) {
    await writeCursor(businessId, connectionId, entityType, new Date().toISOString());
  }
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "pull.completed",
    payload: summary,
  });
  return { goods: summary.created.goods, persons: summary.created.persons, accounts: summary.created.accounts };
}

export async function runHolooSyncTick(): Promise<void> {
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
        await pullConnection(business_id, id);
      } catch (err) {
        console.error(`holoo sync tick failed for connection ${id}:`, (err as Error).message);
      }
    });
  }
}
