/**
 * Phase 27 Wave 5 — loyalty points, store credit and the repurchase list
 * (DB-touching).
 *
 * Points are a signed ledger (`customer_points`): earn positive, redeem
 * negative, balance is a SUM. Store credit is a liability reconstructed from
 * the domain events that posted it — never a mutable column — exactly the
 * "what is owed to a consignor" discipline consignment-service.ts follows.
 * The repeat-purchase prediction itself is pure (repurchase.ts); this file
 * fetches the history and filters the results.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { getPool } from "./db";
import { rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { predictNextPurchase } from "./repurchase";
import { loyaltyRedemptionSummary } from "./industry-reports";
import type { SettlementMethod } from "./ledger";
// Side-effect import: registers the store-credit posting rules.
import "./loyalty-posting-rules";

export interface LoyaltyProgram {
  id: string;
  businessId: string;
  name: string;
  earnPointsPer100000: number;
  pointValueRial: number;
  pointsExpiryDays: number | null;
  isActive: boolean;
  isDefault: boolean;
}

interface ProgramRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  earn_points_per_100000: number;
  point_value_rial: number;
  points_expiry_days: number | null;
  is_active: boolean;
  is_default: boolean;
}

function mapProgram(row: ProgramRow): LoyaltyProgram {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    earnPointsPer100000: row.earn_points_per_100000,
    pointValueRial: row.point_value_rial,
    pointsExpiryDays: row.points_expiry_days,
    isActive: row.is_active,
    isDefault: row.is_default,
  };
}

export async function listPrograms(businessId: string): Promise<LoyaltyProgram[]> {
  const { rows } = await query<ProgramRow>(
    `SELECT * FROM loyalty_programs WHERE business_id = $1 ORDER BY is_default DESC, name`,
    [businessId],
  );
  return rows.map(mapProgram);
}

export async function getDefaultProgram(businessId: string, client?: PoolClient): Promise<LoyaltyProgram | null> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<ProgramRow>(
    `SELECT * FROM loyalty_programs
      WHERE business_id = $1 AND is_active AND is_default
      LIMIT 1`,
    [businessId],
  );
  return rows[0] ? mapProgram(rows[0]) : null;
}

export async function upsertProgram(
  businessId: string,
  input: {
    name: string;
    earnPointsPer100000?: number;
    pointValueRial?: number;
    pointsExpiryDays?: number | null;
    isActive?: boolean;
    isDefault?: boolean;
  },
): Promise<LoyaltyProgram> {
  const name = input.name?.trim();
  if (!name) throw new Error("نام برنامه وفاداری نمی‌تواند خالی باشد.");
  const earnRate = input.earnPointsPer100000 ?? 1;
  // Integer checks, not just sign checks: both columns are `integer`, and a
  // fractional value otherwise surfaced as an opaque database error.
  if (!Number.isSafeInteger(earnRate) || earnRate < 0) {
    throw new Error("نرخ کسب امتیاز باید یک عدد صحیح صفر یا بیشتر باشد.");
  }
  const pointValue = input.pointValueRial ?? 1000;
  if (!Number.isSafeInteger(pointValue) || pointValue <= 0) {
    throw new Error("ارزش ریالی هر امتیاز باید یک عدد صحیح مثبت باشد.");
  }
  if (
    input.pointsExpiryDays !== undefined &&
    input.pointsExpiryDays !== null &&
    (!Number.isSafeInteger(input.pointsExpiryDays) || input.pointsExpiryDays <= 0)
  ) {
    throw new Error("روزهای انقضای امتیاز باید عدد صحیح مثبت باشد یا خالی بماند.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // The unique index gives us "at most one" default. The business-scoped
    // advisory lock gives us the other half: concurrent creates cannot leave
    // active programs with no deterministic default for sales to use.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loyalty-program:${businessId}`]);
    const [{ rows: defaultRows }, { rows: existingRows }] = await Promise.all([
      client.query<Pick<ProgramRow, "id">>(
        `SELECT id
           FROM loyalty_programs
          WHERE business_id = $1 AND is_active AND is_default
          FOR UPDATE`,
        [businessId],
      ),
      client.query<Pick<ProgramRow, "id" | "is_active" | "is_default">>(
        `SELECT id, is_active, is_default
           FROM loyalty_programs
          WHERE business_id = $1 AND name = $2
          FOR UPDATE`,
        [businessId, name],
      ),
    ]);
    const existing = existingRows[0];
    const isActive = input.isActive ?? existing?.is_active ?? true;
    const requestedDefault = input.isDefault ?? existing?.is_default ?? false;
    // First active program (including a repair of an old inactive default)
    // must become the selected program rather than relying on arbitrary order.
    const isDefault = requestedDefault || (!defaultRows[0] && isActive);

    if (isDefault && !isActive) {
      throw new Error("برنامهٔ پیش‌فرض باید فعال باشد.");
    }
    if (!isDefault && existing?.is_default && defaultRows.length === 1) {
      throw new Error("حداقل یک برنامهٔ فعال باید پیش‌فرض بماند.");
    }
    if (!isActive && existing?.is_default && defaultRows.length === 1) {
      throw new Error("برای غیرفعال‌کردن برنامهٔ پیش‌فرض، ابتدا یک برنامهٔ فعال دیگر را پیش‌فرض کنید.");
    }

    // Demote before the upsert when selecting a different program. An ordinary
    // edit of the program already selected must not churn every row or replace
    // omitted fields with client defaults.
    if (isDefault && (input.isDefault === true || !existing?.is_default)) {
      await client.query(`UPDATE loyalty_programs SET is_default = false WHERE business_id = $1`, [businessId]);
    }

    // Omitted numeric/expiry values retain their stored value when editing an
    // existing program; `null` expiry deliberately means "never expires".
    const expiryProvided = input.pointsExpiryDays !== undefined;
    const writeIsActive = existing && input.isActive === undefined ? null : isActive;
    const writeIsDefault = existing && input.isDefault === undefined && existing.is_default === isDefault ? null : isDefault;
    const { rows } = await client.query<ProgramRow>(
      `INSERT INTO loyalty_programs
         (business_id, name, earn_points_per_100000, point_value_rial, points_expiry_days, is_active, is_default)
       VALUES ($1, $2, COALESCE($3, 1), COALESCE($4, 1000), $6, $7, $8)
       ON CONFLICT (business_id, name) DO UPDATE
         SET earn_points_per_100000 = COALESCE($3, loyalty_programs.earn_points_per_100000),
             point_value_rial = COALESCE($4, loyalty_programs.point_value_rial),
             points_expiry_days = CASE WHEN $5 THEN $6 ELSE loyalty_programs.points_expiry_days END,
             is_active = COALESCE($7, loyalty_programs.is_active),
             is_default = COALESCE($8, loyalty_programs.is_default)
       RETURNING *`,
      [
        businessId,
        name,
        input.earnPointsPer100000 ?? null,
        input.pointValueRial ?? null,
        expiryProvided,
        input.pointsExpiryDays ?? null,
        writeIsActive,
        writeIsDefault,
      ],
    );
    await client.query("COMMIT");
    return mapProgram(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Balance = Σ earned − Σ redeemed, honouring expiry. Never a stored column.
 *
 * `expires_at` is written on every earn and the program screen advertises
 * «انقضای امتیاز», so lapsed points must actually lapse — a plain SUM never
 * enforced it. The ledger is replayed as earn *lots*: each redemption (at its
 * own date) consumes from the lots that were still valid on that day,
 * soonest-expiring first, and the balance is what remains in the lots that
 * are still valid today. This way an expired lot forfeits only the part of it
 * that was never spent in time, a redemption made before expiry keeps
 * counting against the lot it actually drew from, and the result can never go
 * negative through expiry alone.
 */
export async function pointsBalance(businessId: string, customerId: string, client?: PoolClient): Promise<number> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<{ points: number; expires_at: string | null; created_on: string }>(
    `SELECT points, expires_at::text AS expires_at, (created_at AT TIME ZONE 'UTC')::date::text AS created_on
       FROM customer_points
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY created_at, id`,
    [businessId, customerId],
  );

  const lots: { remaining: number; expiresAt: string | null }[] = [];
  for (const row of rows) {
    if (row.points > 0) {
      lots.push({ remaining: row.points, expiresAt: row.expires_at });
      continue;
    }
    let toConsume = -row.points;
    // Lots valid on the redemption's own day, soonest-expiring first — the
    // order any loyalty scheme spends in, and the one that forfeits least.
    const usable = lots
      .filter((lot) => lot.remaining > 0 && (lot.expiresAt === null || lot.expiresAt >= row.created_on))
      .sort((a, b) => (a.expiresAt ?? "9999-12-31").localeCompare(b.expiresAt ?? "9999-12-31"));
    for (const lot of usable) {
      if (toConsume <= 0) break;
      const take = Math.min(lot.remaining, toConsume);
      lot.remaining -= take;
      toConsume -= take;
    }
    // Historical over-redemption (recorded before the balance check existed):
    // absorb it against whatever is left rather than resurrecting points.
    for (const lot of lots) {
      if (toConsume <= 0) break;
      const take = Math.min(lot.remaining, toConsume);
      lot.remaining -= take;
      toConsume -= take;
    }
  }

  const today = todayIso();
  return lots
    .filter((lot) => lot.expiresAt === null || lot.expiresAt >= today)
    .reduce((sum, lot) => sum + lot.remaining, 0);
}

export interface EarnPointsResult {
  points: number;
  programId: string | null;
}

/**
 * Credits points for a sale, in the caller's own transaction. Runs on the
 * business's default active program; a business with no program (or a
 * zero earn rate) earns nothing, which is not an error.
 */
export async function earnPoints(
  client: PoolClient,
  input: {
    businessId: string;
    customerId: string;
    /** Rial, whole — the settled invoice total the points are earned on. */
    amountRial: RialText;
    sourceType: string;
    sourceId: string;
    createdBy?: string | null;
  },
): Promise<EarnPointsResult> {
  const program = await getDefaultProgram(input.businessId, client);
  if (!program || program.earnPointsPer100000 === 0) return { points: 0, programId: null };

  const points = Number((BigInt(input.amountRial) * BigInt(program.earnPointsPer100000)) / 100_000n);
  if (points <= 0) return { points: 0, programId: program.id };

  await client.query(
    `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.businessId,
      input.customerId,
      points,
      input.sourceType,
      input.sourceId,
      program.pointsExpiryDays ? addDaysIso(program.pointsExpiryDays) : null,
    ],
  );
  return { points, programId: program.id };
}

/**
 * Redeems points into store credit: a negative points row (so the points
 * ledger nets to zero) plus a `loyalty.store_credit_issued` event for the
 * Rial value, which posts the liability the customer can spend on a later
 * invoice. Refuses to redeem more points than the balance.
 */
export async function redeemPoints(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    points: number;
    createdBy?: string | null;
  },
): Promise<{ points: number; valueRial: number; entryId: string | null }> {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw new Error("تعداد امتیاز باید یک عدد صحیح مثبت باشد.");
  }
  const program = await getDefaultProgram(input.businessId, client);
  if (!program) throw new Error("برنامه وفاداری تعریف نشده است.");

  // The balance is a SUM over an append-only ledger, not one row — there is
  // nothing for SELECT ... FOR UPDATE to lock. Without this, two concurrent
  // redemptions for the same customer can both read the same balance, both
  // pass the check below, and both insert: the ledger nets negative and the
  // customer is issued store credit for points they didn't have.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `loyalty-points:${input.businessId}:${input.customerId}`,
  ]);
  const balance = await pointsBalance(input.businessId, input.customerId, client);
  if (input.points > balance) throw new Error("امتیاز کافی نیست.");

  const valueRial = input.points * program.pointValueRial;

  // Match each debit to the lot it consumed. Current projections can then
  // exclude an expired lot and its matching redemption together; otherwise an
  // old, expiry-less debit would make an expired balance look permanently
  // negative outside this service.
  const { rows: lots } = await client.query<{ expires_at: string | null; points: string }>(
    `SELECT expires_at::text, COALESCE(SUM(points), 0)::text AS points
       FROM customer_points
      WHERE business_id = $1 AND customer_id = $2
        AND (expires_at IS NULL OR expires_at >= current_date)
      GROUP BY expires_at
      HAVING COALESCE(SUM(points), 0) > 0
      ORDER BY expires_at NULLS LAST`,
    [input.businessId, input.customerId],
  );
  let remaining = input.points;
  for (const lot of lots) {
    if (remaining === 0) break;
    const consumed = Math.min(remaining, Number(lot.points));
    if (consumed <= 0) continue;
    await client.query(
      `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id, expires_at)
       VALUES ($1, $2, $3, 'redeem', NULL, $4::date)`,
      [input.businessId, input.customerId, -consumed, lot.expires_at],
    );
    remaining -= consumed;
  }
  // The customer-level lock and the preceding ledger replay make this a
  // malformed-historical-ledger guard rather than a normal user-facing path.
  if (remaining > 0) throw new Error("امتیاز کافی نیست.");

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_issued",
    payload: { customerId: input.customerId, amount: rialText(String(valueRial)), reason: "points_redemption" },
    sourceType: "loyalty_points_redemption",
    sourceId: input.customerId,
    createdBy: input.createdBy ?? null,
  });

  return { points: input.points, valueRial, entryId };
}

/** A customer's store-credit balance, reconstructed from the event log — the same shape as a consignor statement. */
export async function storeCreditBalance(businessId: string, customerId: string, client?: PoolClient): Promise<number> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows } = await run<{ issued: string | null; used: string | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'loyalty.store_credit_issued'
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS issued,
       COALESCE(SUM(CASE WHEN event_type = 'loyalty.store_credit_used'
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS used
       FROM domain_events
      WHERE business_id = $1 AND payload->>'customerId' = $2`,
    [businessId, customerId],
  );
  return Number(rows[0]?.issued ?? 0) - Number(rows[0]?.used ?? 0);
}

export async function issueStoreCredit(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    amount: number;
    reason?: string | null;
    createdBy?: string | null;
  },
): Promise<{ entryId: string | null }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("مبلغ اعتبار باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_issued",
    payload: { customerId: input.customerId, amount: rialText(String(input.amount)), reason: input.reason ?? null },
    sourceType: "loyalty_store_credit",
    sourceId: input.customerId,
    createdBy: input.createdBy ?? null,
  });
  return { entryId };
}

export async function useStoreCredit(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    customerId: string;
    amount: number;
    paymentMethod: Extract<SettlementMethod, "cash" | "bank">;
    createdBy?: string | null;
  },
): Promise<{ entryId: string | null; balance: number }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("مبلغ مصرف اعتبار باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  // Same race as redeemPoints above: the balance is reconstructed from
  // domain_events, so two concurrent spends must be serialized by an
  // advisory lock rather than a row lock.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `loyalty-store-credit:${input.businessId}:${input.customerId}`,
  ]);
  const balance = await storeCreditBalance(input.businessId, input.customerId, client);
  if (input.amount > balance) throw new Error("اعتبار فروشگاهی کافی نیست.");

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "loyalty.store_credit_used",
    payload: {
      customerId: input.customerId,
      amount: rialText(String(input.amount)),
      paymentMethod: input.paymentMethod,
    },
    sourceType: "loyalty_store_credit_use",
    sourceId: input.customerId,
    createdBy: input.createdBy ?? null,
  });
  return { entryId, balance: balance - input.amount };
}

export interface DueForRepurchaseRow {
  customerId: string;
  customerName: string;
  productId: string;
  productName: string;
  predictedDate: string;
  avgIntervalDays: number;
}

/**
 * Phase 27 Wave 13 — the loyalty redemption report: earned vs redeemed over
 * a window, with the redeemed points' Rial value derived from the business's
 * default program (point_value_rial), so the owner sees what redemptions cost
 * them, not just a points count.
 */
export async function loyaltyRedemptionReport(
  businessId: string,
  range: { from?: string | null; to?: string | null },
): Promise<{
  summary: ReturnType<typeof loyaltyRedemptionSummary> & { redeemedValueRial: number };
}> {
  const { rows } = await query<{ points: number; source_type: string }>(
    `SELECT points, source_type
       FROM customer_points
      WHERE business_id = $1
        AND ($2::date IS NULL OR created_at::date >= $2::date)
        AND ($3::date IS NULL OR created_at::date <= $3::date)`,
    [businessId, range.from ?? null, range.to ?? null],
  );
  const summary = loyaltyRedemptionSummary(
    rows.map((r) => ({ points: r.points, sourceType: r.source_type })),
  );
  const program = await getDefaultProgram(businessId);
  return { summary: { ...summary, redeemedValueRial: summary.redeemedPoints * (program?.pointValueRial ?? 0) } };
}

/**
 * The «آماده خرید مجدد» list: customers whose predicted next purchase date
 * for a product has passed, scoped to the caller's branch. Prediction comes
 * from repurchase.ts over the customer's own completed-order history.
 */
export async function customersDueForRepurchase(
  businessId: string,
  locationId: string,
  today: string,
): Promise<DueForRepurchaseRow[]> {
  const { rows } = await query<{
    customer_id: string;
    customer_name: string;
    product_id: string;
    product_name: string;
    dates: string[];
  }>(
    `SELECT o.customer_id, c.name AS customer_name,
            COALESCE(oi.item_id::text, oi.menu_item_id::text) AS product_id,
            oi.name_snapshot AS product_name,
            array_agg(DISTINCT (o.closed_at AT TIME ZONE 'UTC')::date::text ORDER BY (o.closed_at AT TIME ZONE 'UTC')::date::text) AS dates
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN parties c ON c.id = o.customer_id
      WHERE o.location_id = $1
        AND o.status = 'completed' AND o.customer_id IS NOT NULL
        AND (oi.item_id IS NOT NULL OR oi.menu_item_id IS NOT NULL)
      GROUP BY o.customer_id, c.name, COALESCE(oi.item_id::text, oi.menu_item_id::text), oi.name_snapshot`,
    [locationId],
  );

  const due: DueForRepurchaseRow[] = [];
  for (const row of rows) {
    const prediction = predictNextPurchase({ dates: row.dates });
    if (prediction.reliable && prediction.nextPurchaseDate && prediction.nextPurchaseDate <= today) {
      due.push({
        customerId: row.customer_id,
        customerName: row.customer_name,
        productId: row.product_id,
        productName: row.product_name,
        predictedDate: prediction.nextPurchaseDate,
        avgIntervalDays: prediction.avgIntervalDays,
      });
    }
  }
  return due.sort((a, b) => a.predictedDate.localeCompare(b.predictedDate));
}
