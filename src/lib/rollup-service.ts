/**
 * Phase 9 — multi-location rollup: the DB-touching half (not unit-tested
 * directly, like the other *-service.ts files). Two roles live here because
 * a "central" server is just another deployment of this app:
 *
 *  - LOCAL side: build this location's daily summaries from the Phase 8
 *    reporting views (never raw transactional tables) and push them to the
 *    configured central server. Runs on a timer (server.ts) and on demand.
 *  - CENTRAL side: register locations (issuing a bearer token whose hash is
 *    the only thing stored), ingest pushes idempotently, and serve the
 *    Owner's cross-location overview.
 */
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  computePushFromDay,
  generateRollupToken,
  hashRollupToken,
  isSyncStale,
  type RollupDay,
  type RollupPushPayload,
  type RollupStaffDay,
} from "./rollup";

// ---------------------------------------------------------------------------
// Local side: config, payload building, push
// ---------------------------------------------------------------------------

export interface RollupConfig {
  centralUrl: string;
  token: string;
  enabled: boolean;
}

export interface RollupSyncState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** last business day confirmed received by central (resend window starts before it) */
  lastSuccessDay: string | null;
  lastError: string | null;
}

const EMPTY_SYNC_STATE: RollupSyncState = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastSuccessDay: null,
  lastError: null,
};

export async function getRollupConfig(businessId: string): Promise<RollupConfig | null> {
  return getSetting<RollupConfig>(businessId, SETTING_KEYS.rollupConfig);
}

export async function setRollupConfig(businessId: string, config: RollupConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.rollupConfig, config);
}

export async function getRollupSyncState(businessId: string): Promise<RollupSyncState> {
  const s = await getSetting<RollupSyncState>(businessId, SETTING_KEYS.rollupSyncState);
  return s ?? { ...EMPTY_SYNC_STATE };
}

function blankDay(businessDay: string): RollupDay {
  return {
    businessDay,
    orderCount: 0,
    subtotal: 0,
    discount: 0,
    serviceCharge: 0,
    tax: 0,
    total: 0,
    cashTotal: 0,
    cardTotal: 0,
    onlineTotal: 0,
    creditTotal: 0,
    cogs: 0,
    wasteCost: 0,
    staff: [],
  };
}

/**
 * Assemble this location's push payload from the Phase 8 reporting views —
 * the same numbers its own reports show, so central and local always agree.
 * `fromDay` null = full history (first sync); business days are bucketed in
 * the location's own timezone by the views themselves.
 */
export async function buildRollupPayload(
  businessId: string,
  fromDay: string | null,
): Promise<RollupPushPayload | null> {
  const { rows: locRows } = await query<{ id: string; name: string; timezone: string }>(
    `SELECT id, name, timezone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  const location = locRows[0];
  if (!location) return null;

  const days = new Map<string, RollupDay>();
  const dayFor = (businessDay: string): RollupDay => {
    let d = days.get(businessDay);
    if (!d) {
      d = blankDay(businessDay);
      days.set(businessDay, d);
    }
    return d;
  };

  const [sales, payments, cogs, waste, staff] = await Promise.all([
    query<{
      day: string;
      order_count: string;
      subtotal: string;
      discount: string;
      service_charge: string;
      tax: string;
      total: string;
    }>(
      `SELECT sale_date::text AS day, order_count, subtotal, discount, service_charge, tax, total
         FROM v_sales_by_day
        WHERE location_id = $1 AND ($2::date IS NULL OR sale_date >= $2)`,
      [location.id, fromDay],
    ),
    query<{ day: string; cash: string; card: string; online: string; credit: string }>(
      `SELECT business_date::text AS day,
              sum(cash_total)   AS cash,
              sum(card_total)   AS card,
              sum(online_total) AS online,
              sum(credit_total) AS credit
         FROM v_shift_reconciliation
        WHERE location_id = $1 AND ($2::date IS NULL OR business_date >= $2)
        GROUP BY business_date`,
      [location.id, fromDay],
    ),
    query<{ day: string; cogs: string }>(
      `SELECT entry_date::text AS day, sum(debit) - sum(credit) AS cogs
         FROM v_ledger_by_account
        WHERE business_id = $1 AND location_id = $2 AND account_code = $3
          AND ($4::date IS NULL OR entry_date >= $4)
        GROUP BY entry_date`,
      [businessId, location.id, WELL_KNOWN_CODES.cogs, fromDay],
    ),
    query<{ day: string; cost: string }>(
      `SELECT waste_date::text AS day, round(sum(cost)) AS cost
         FROM v_waste_summary
        WHERE location_id = $1 AND ($2::date IS NULL OR waste_date >= $2)
        GROUP BY waste_date`,
      [location.id, fromDay],
    ),
    query<{
      day: string;
      staff_id: string;
      staff_name: string;
      role: string;
      order_count: string;
      revenue: string;
    }>(
      `SELECT business_date::text AS day, staff_id, staff_name, role::text AS role,
              order_count, revenue
         FROM v_staff_performance
        WHERE location_id = $1 AND ($2::date IS NULL OR business_date >= $2)`,
      [location.id, fromDay],
    ),
  ]);

  for (const r of sales.rows) {
    const d = dayFor(r.day);
    d.orderCount = Number(r.order_count);
    d.subtotal = Number(r.subtotal);
    d.discount = Number(r.discount);
    d.serviceCharge = Number(r.service_charge);
    d.tax = Number(r.tax);
    d.total = Number(r.total);
  }
  for (const r of payments.rows) {
    const d = dayFor(r.day);
    d.cashTotal = Number(r.cash);
    d.cardTotal = Number(r.card);
    d.onlineTotal = Number(r.online);
    d.creditTotal = Number(r.credit);
  }
  for (const r of cogs.rows) dayFor(r.day).cogs = Number(r.cogs);
  for (const r of waste.rows) dayFor(r.day).wasteCost = Number(r.cost);
  for (const r of staff.rows) {
    dayFor(r.day).staff.push({
      staffId: r.staff_id,
      staffName: r.staff_name,
      role: r.role,
      orderCount: Number(r.order_count),
      revenue: Number(r.revenue),
    });
  }

  return {
    location: { id: location.id, name: location.name, timezone: location.timezone },
    days: [...days.values()].sort((a, b) => a.businessDay.localeCompare(b.businessDay)),
  };
}

export type RollupPushResult =
  | { status: "disabled" }
  | { status: "ok"; daysPushed: number }
  | { status: "error"; error: string };

/**
 * One push attempt: window since the last confirmed day (with overlap), POST
 * to central, record the outcome in settings. Failures just record the error
 * — the next tick (or a manual "sync now") retries the same widened window,
 * which is the whole offline-catch-up story (pushes are idempotent upserts).
 */
export async function runRollupPush(businessId: string): Promise<RollupPushResult> {
  const config = await getRollupConfig(businessId);
  if (!config?.enabled || !config.centralUrl?.trim() || !config.token?.trim()) {
    return { status: "disabled" };
  }

  const state = await getRollupSyncState(businessId);
  const attempt: RollupSyncState = { ...state, lastAttemptAt: new Date().toISOString() };

  const fail = async (error: string): Promise<RollupPushResult> => {
    await setSetting(businessId, SETTING_KEYS.rollupSyncState, { ...attempt, lastError: error });
    return { status: "error", error };
  };

  let payload: RollupPushPayload | null;
  try {
    payload = await buildRollupPayload(businessId, computePushFromDay(state.lastSuccessDay));
  } catch (err) {
    return fail(`build_failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!payload) return fail("no_location");

  const url = `${config.centralUrl.trim().replace(/\/+$/, "")}/api/rollup/ingest`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token.trim()}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return fail(`central_rejected: HTTP ${res.status}`);
    }
  } catch (err) {
    return fail(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lastDay = payload.days.at(-1)?.businessDay ?? state.lastSuccessDay;
  await setSetting(businessId, SETTING_KEYS.rollupSyncState, {
    lastAttemptAt: attempt.lastAttemptAt,
    lastSuccessAt: new Date().toISOString(),
    lastSuccessDay: lastDay,
    lastError: null,
  } satisfies RollupSyncState);
  return { status: "ok", daysPushed: payload.days.length };
}

/** Timer entry point (server.ts): push for every business that configured a central. */
export async function runRollupSyncTick(): Promise<void> {
  // Finding *which* businesses have a central configured spans tenants, so the
  // discovery query is bypassed; each business's push then runs scoped to it,
  // exactly as a request from that business would (Phase 12).
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT business_id FROM settings WHERE key = $1 AND location_id IS NULL`,
      [SETTING_KEYS.rollupConfig],
    );
    return result.rows;
  });

  for (const row of rows) {
    try {
      await withTenant(row.business_id, () => runRollupPush(row.business_id));
    } catch (err) {
      // Never let one business's failure stop the tick; state already records per-business errors.
      console.error(`rollup push failed for business ${row.business_id}:`, err);
    }
  }
}

/** Today's business day in the business's own timezone (its primary location's, Tehran fallback). */
export async function getBusinessToday(businessId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `SELECT (now() AT TIME ZONE coalesce(
              (SELECT timezone FROM locations
                WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1),
              'Asia/Tehran'))::date::text AS today`,
    [businessId],
  );
  return rows[0].today;
}

// ---------------------------------------------------------------------------
// Central side: registration, ingest, overview
// ---------------------------------------------------------------------------

export interface RollupLocationRow {
  id: string;
  name: string;
  sourceLocationId: string | null;
  timezone: string | null;
  lastSyncedAt: string | null;
  stale: boolean;
  isActive: boolean;
  createdAt: string;
}

export async function listRollupLocations(businessId: string): Promise<RollupLocationRow[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    source_location_id: string | null;
    timezone: string | null;
    last_synced_at: Date | null;
    is_active: boolean;
    created_at: Date;
  }>(
    `SELECT id, name, source_location_id, timezone, last_synced_at, is_active, created_at
       FROM rollup_locations WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceLocationId: r.source_location_id,
    timezone: r.timezone,
    lastSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
    stale: isSyncStale(r.last_synced_at),
    isActive: r.is_active,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Register a remote location and return its bearer token — the only time the plaintext exists. */
export async function registerRollupLocation(
  businessId: string,
  name: string,
): Promise<{ id: string; name: string; token: string }> {
  const token = generateRollupToken();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO rollup_locations (business_id, name, token_hash) VALUES ($1, $2, $3) RETURNING id`,
    [businessId, name, hashRollupToken(token)],
  );
  return { id: rows[0].id, name, token };
}

export async function setRollupLocationActive(
  businessId: string,
  id: string,
  isActive: boolean,
): Promise<boolean> {
  const res = await query(
    `UPDATE rollup_locations SET is_active = $3 WHERE id = $1 AND business_id = $2`,
    [id, businessId, isActive],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Apply a validated push. Day summaries upsert on (location, day); a day's
 * staff rows are replaced wholesale (the re-pushed day is the new truth).
 * Returns null when the token doesn't match an active registration.
 */
export async function ingestRollup(
  token: string,
  payload: RollupPushPayload,
): Promise<{ daysApplied: number } | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM rollup_locations WHERE token_hash = $1 AND is_active`,
    [hashRollupToken(token)],
  );
  const rollupLocationId = rows[0]?.id;
  if (!rollupLocationId) return null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const day of payload.days) {
      await client.query(
        `INSERT INTO rollup_daily_summary (
            rollup_location_id, business_day, order_count, subtotal, discount,
            service_charge, tax, total, cash_total, card_total, online_total,
            credit_total, cogs, waste_cost, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
         ON CONFLICT (rollup_location_id, business_day) DO UPDATE SET
            order_count = EXCLUDED.order_count, subtotal = EXCLUDED.subtotal,
            discount = EXCLUDED.discount, service_charge = EXCLUDED.service_charge,
            tax = EXCLUDED.tax, total = EXCLUDED.total,
            cash_total = EXCLUDED.cash_total, card_total = EXCLUDED.card_total,
            online_total = EXCLUDED.online_total, credit_total = EXCLUDED.credit_total,
            cogs = EXCLUDED.cogs, waste_cost = EXCLUDED.waste_cost, synced_at = now()`,
        [
          rollupLocationId,
          day.businessDay,
          day.orderCount,
          day.subtotal,
          day.discount,
          day.serviceCharge,
          day.tax,
          day.total,
          day.cashTotal,
          day.cardTotal,
          day.onlineTotal,
          day.creditTotal,
          day.cogs,
          day.wasteCost,
        ],
      );
      await client.query(
        `DELETE FROM rollup_daily_staff WHERE rollup_location_id = $1 AND business_day = $2`,
        [rollupLocationId, day.businessDay],
      );
      for (const s of day.staff) {
        await client.query(
          `INSERT INTO rollup_daily_staff (
              rollup_location_id, business_day, source_staff_id, staff_name, role,
              order_count, revenue)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [rollupLocationId, day.businessDay, s.staffId, s.staffName, s.role, s.orderCount, s.revenue],
        );
      }
    }
    await client.query(
      `UPDATE rollup_locations
          SET last_synced_at = now(), source_location_id = $2, timezone = $3
        WHERE id = $1`,
      [rollupLocationId, payload.location.id, payload.location.timezone],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { daysApplied: payload.days.length };
}

export interface RollupLocationTotals {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  stale: boolean;
  orderCount: number;
  total: number;
  discount: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
  cogs: number;
  wasteCost: number;
  topStaff: RollupStaffDay[];
}

export interface RollupOverview {
  from: string;
  to: string;
  locations: RollupLocationTotals[];
  /** per-location daily sales series for the comparison chart */
  series: { day: string; locationId: string; total: number }[];
}

/** The Owner's cross-location comparison, over an inclusive day range. */
export async function getRollupOverview(
  businessId: string,
  from: string,
  to: string,
): Promise<RollupOverview> {
  const [locs, totals, staff, series] = await Promise.all([
    listRollupLocations(businessId),
    query<{
      rollup_location_id: string;
      order_count: string | null;
      total: string | null;
      discount: string | null;
      cash_total: string | null;
      card_total: string | null;
      online_total: string | null;
      credit_total: string | null;
      cogs: string | null;
      waste_cost: string | null;
    }>(
      `SELECT s.rollup_location_id,
              sum(s.order_count) AS order_count, sum(s.total) AS total,
              sum(s.discount) AS discount,
              sum(s.cash_total) AS cash_total, sum(s.card_total) AS card_total,
              sum(s.online_total) AS online_total, sum(s.credit_total) AS credit_total,
              sum(s.cogs) AS cogs, sum(s.waste_cost) AS waste_cost
         FROM rollup_daily_summary s
         JOIN rollup_locations rl ON rl.id = s.rollup_location_id
        WHERE rl.business_id = $1 AND s.business_day BETWEEN $2 AND $3
        GROUP BY s.rollup_location_id`,
      [businessId, from, to],
    ),
    query<{
      rollup_location_id: string;
      source_staff_id: string;
      staff_name: string;
      role: string | null;
      order_count: string;
      revenue: string;
    }>(
      `SELECT * FROM (
         SELECT st.rollup_location_id, st.source_staff_id,
                max(st.staff_name) AS staff_name, max(st.role) AS role,
                sum(st.order_count) AS order_count, sum(st.revenue) AS revenue,
                row_number() OVER (
                  PARTITION BY st.rollup_location_id ORDER BY sum(st.revenue) DESC
                ) AS rank
           FROM rollup_daily_staff st
           JOIN rollup_locations rl ON rl.id = st.rollup_location_id
          WHERE rl.business_id = $1 AND st.business_day BETWEEN $2 AND $3
          GROUP BY st.rollup_location_id, st.source_staff_id
       ) ranked WHERE rank <= 5`,
      [businessId, from, to],
    ),
    query<{ rollup_location_id: string; day: string; total: string }>(
      `SELECT s.rollup_location_id, s.business_day::text AS day, s.total
         FROM rollup_daily_summary s
         JOIN rollup_locations rl ON rl.id = s.rollup_location_id
        WHERE rl.business_id = $1 AND s.business_day BETWEEN $2 AND $3
        ORDER BY s.business_day`,
      [businessId, from, to],
    ),
  ]);

  const totalsByLoc = new Map(totals.rows.map((r) => [r.rollup_location_id, r]));
  const staffByLoc = new Map<string, RollupStaffDay[]>();
  for (const r of staff.rows) {
    const list = staffByLoc.get(r.rollup_location_id) ?? [];
    list.push({
      staffId: r.source_staff_id,
      staffName: r.staff_name,
      role: r.role,
      orderCount: Number(r.order_count),
      revenue: Number(r.revenue),
    });
    staffByLoc.set(r.rollup_location_id, list);
  }

  return {
    from,
    to,
    locations: locs
      .filter((l) => l.isActive)
      .map((l) => {
        const t = totalsByLoc.get(l.id);
        return {
          id: l.id,
          name: l.name,
          lastSyncedAt: l.lastSyncedAt,
          stale: l.stale,
          orderCount: Number(t?.order_count ?? 0),
          total: Number(t?.total ?? 0),
          discount: Number(t?.discount ?? 0),
          cashTotal: Number(t?.cash_total ?? 0),
          cardTotal: Number(t?.card_total ?? 0),
          onlineTotal: Number(t?.online_total ?? 0),
          creditTotal: Number(t?.credit_total ?? 0),
          cogs: Number(t?.cogs ?? 0),
          wasteCost: Number(t?.waste_cost ?? 0),
          topStaff: staffByLoc.get(l.id) ?? [],
        };
      }),
    series: series.rows.map((r) => ({
      day: r.day,
      locationId: r.rollup_location_id,
      total: Number(r.total),
    })),
  };
}
