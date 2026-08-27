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
import { connectHolooSql, type HolooSqlClient } from "./client";
import { matchProfile, profileForKey, type HolooSchemaProfile } from "./schema-profile";
import { applyBaseImport, type BaseImportInput } from "./import-service";
import { mapAccount, mapGoods, mapOpeningInventory, mapPerson } from "./mappers";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_SYNC_TICK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;

type CursorEntity = "goods" | "persons" | "accounts" | "openingInventory";

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

function ident(name: string): string {
  return `[${name.replace(/]/g, "]]")}]`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function cursorExpr(column: string | undefined, fallback: string): string {
  return ident(column ?? fallback);
}

function selectSql(
  profile: HolooSchemaProfile,
  entity: CursorEntity,
  columns: Record<string, string | undefined>,
  cursorColumn: string | undefined,
  fallbackCursorColumn: string,
  lastKey: string | null,
): string {
  const table =
    entity === "goods"
      ? profile.tables.goods
      : entity === "persons"
        ? profile.tables.persons
        : entity === "accounts"
          ? profile.tables.accounts
          : profile.tables.stock_movements;
  const cursor = cursorExpr(cursorColumn, fallbackCursorColumn);
  const projection = Object.entries(columns)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([alias, column]) => `${ident(column)} AS ${ident(alias)}`);
  projection.push(`${cursor} AS ${ident("cursor_key")}`);
  const where = lastKey ? `WHERE CONVERT(nvarchar(100), ${cursor}, 126) > ${literal(lastKey)}` : "";
  return `SELECT TOP (${BATCH_SIZE}) ${projection.join(", ")} FROM ${ident(table)} ${where} ORDER BY ${cursor}, ${ident(fallbackCursorColumn)}`;
}

function asString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "supplier" || text === "تأمین‌کننده";
}

async function pullBaseRows(
  client: HolooSqlClient,
  profile: HolooSchemaProfile,
  settings: NonNullable<Awaited<ReturnType<typeof getHolooSettingsRow>>>,
  cursors: Record<CursorEntity, string | null>,
): Promise<{ input: BaseImportInput; nextCursors: Partial<Record<CursorEntity, string>> }> {
  const goodsColumns = profile.columns.goods;
  const personColumns = profile.columns.persons;
  const accountColumns = profile.columns.accounts;
  const stockColumns = profile.columns.stockMovements;

  const [goodsRows, personRows, accountRows, stockRows] = await Promise.all([
    client.query<Record<string, unknown>>(
      selectSql(profile, "goods", goodsColumns, goodsColumns.updatedAt, goodsColumns.id, cursors.goods),
    ),
    client.query<Record<string, unknown>>(
      selectSql(profile, "persons", personColumns, personColumns.updatedAt, personColumns.id, cursors.persons),
    ),
    client.query<Record<string, unknown>>(
      selectSql(profile, "accounts", accountColumns, accountColumns.updatedAt, accountColumns.id, cursors.accounts),
    ),
    client.query<Record<string, unknown>>(
      selectSql(
        profile,
        "openingInventory",
        {
          id: stockColumns.id,
          goodsId: stockColumns.goodsId,
          quantity: stockColumns.quantity,
          unitCost: stockColumns.unitCost,
          date: stockColumns.date,
        },
        stockColumns.updatedAt ?? stockColumns.date,
        stockColumns.id,
        cursors.openingInventory,
      ),
    ),
  ]);

  const goodsNameById = new Map(goodsRows.map((row) => [asString(row.id), asString(row.name)]));
  const goodsUnitById = new Map(goodsRows.map((row) => [asString(row.id), asString(row.unit)]));
  const nextCursors: Partial<Record<CursorEntity, string>> = {};
  const remember = (entity: CursorEntity, rows: Record<string, unknown>[]) => {
    if (rows.length === 0) return;
    nextCursors[entity] = asString(rows[rows.length - 1].cursor_key);
  };
  remember("goods", goodsRows);
  remember("persons", personRows);
  remember("accounts", accountRows);
  remember("openingInventory", stockRows);

  return {
    input: {
      goods: goodsRows.map((row) =>
        mapGoods(
          {
            id: asString(row.id),
            name: asString(row.name),
            sku: row.sku == null ? null : asString(row.sku),
            price: row.price as string | number | null | undefined,
            unit: row.unit == null ? null : asString(row.unit),
          },
          settings.currency_unit,
        ),
      ),
      persons: personRows.map((row) =>
        mapPerson({
          id: asString(row.id),
          name: asString(row.name),
          phone: row.phone == null ? null : asString(row.phone),
          address: row.address == null ? null : asString(row.address),
          isSupplier: asBoolean(row.isSupplier),
        }),
      ),
      accounts: accountRows.map((row) =>
        mapAccount({
          id: asString(row.id),
          code: asString(row.code),
          name: asString(row.name),
          nature: row.nature == null ? null : asString(row.nature),
          parentCode: row.parentCode == null ? null : asString(row.parentCode),
        }),
      ),
      openingInventory: stockRows
        .filter((row) => Number(row.quantity ?? 0) > 0)
        .map((row) => {
          const goodsId = row.goodsId == null ? null : asString(row.goodsId);
          return mapOpeningInventory(
            {
              id: asString(row.id),
              goodsId,
              name: goodsId ? (goodsNameById.get(goodsId) ?? goodsId) : asString(row.id),
              unit: goodsId ? (goodsUnitById.get(goodsId) ?? null) : null,
              quantity: row.quantity as string | number,
              unitCost: row.unitCost as string | number | null | undefined,
            },
            settings.currency_unit,
          );
        }),
    },
    nextCursors,
  };
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
): Promise<{ input: BaseImportInput; nextCursors: Partial<Record<CursorEntity, string>> }> {
  const client = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const profile = settings.schema_profile
      ? profileForKey(settings.schema_profile)
      : matchProfile(
          (await client.query<{ TABLE_NAME: string }>(
            `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_TYPE = 'BASE TABLE'`,
          )).map((t) => t.TABLE_NAME),
        );
    if (!profile) {
      await writeIntegrationAudit({ businessId, connectionId, action: "pull.unknown_profile" });
      return { input: { goods: [], persons: [], accounts: [], openingInventory: [] }, nextCursors: {} };
    }
    const cursors = {
      goods: await readCursor(businessId, connectionId, "goods"),
      persons: await readCursor(businessId, connectionId, "persons"),
      accounts: await readCursor(businessId, connectionId, "accounts"),
      openingInventory: await readCursor(businessId, connectionId, "openingInventory"),
    } satisfies Record<CursorEntity, string | null>;
    const pulled = await pullBaseRows(client, profile, settings, cursors);
    return {
      input: pulled.input,
      nextCursors: {
        ...Object.fromEntries(Object.entries(cursors).filter((entry): entry is [CursorEntity, string] => Boolean(entry[1]))),
        ...pulled.nextCursors,
      },
    };
  } finally {
    await client.close();
  }
}

/** Mirror one connection's base data. Returns a summary for the audit log. */
export async function pullConnection(businessId: string, connectionId: string): Promise<{ goods: number; persons: number; accounts: number; openingInventory: number }> {
  if (!(await isFeatureEnabled(businessId, "holoo_companion"))) return { goods: 0, persons: 0, accounts: 0, openingInventory: 0 };
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings || !settings.companion_activated_at) return { goods: 0, persons: 0, accounts: 0, openingInventory: 0 };

  const { input, nextCursors } = await fetchHolooBase(businessId, connectionId, settings);
  const summary = await applyBaseImport(businessId, connectionId, input);
  for (const [entityType, cursor] of Object.entries(nextCursors)) {
    if (cursor) await writeCursor(businessId, connectionId, entityType, cursor);
  }
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "pull.completed",
    payload: summary,
  });
  return {
    goods: summary.created.goods,
    persons: summary.created.persons,
    accounts: summary.created.accounts,
    openingInventory: summary.created.openingInventory,
  };
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
