/**
 * Phase 23 (issue #118) — Wave 5: reconcile a period's WooCommerce order
 * totals against the local ledger's imported-order totals. DB-touching (the
 * pure difference math lives in reconciliation.ts and is unit-tested).
 *
 * Remote side: sums `total` from the store's orders (completed/processing)
 * created in the period. Local side: sums the debit side of the
 * `woocommerce_order` journal entries in the same period (the debit is the
 * order total — bank-clearing — so it equals what the store charged).
 */
import { query } from "../db";
import { getConnection, wooClientFor, type ConnectionRow } from "./connections-service";
import { reconcileTotals } from "./reconciliation";
import { wooAmountToRial } from "./woo-money";
import { writeIntegrationAudit } from "./audit";

const REMOTE_STATUSES = new Set(["completed", "processing"]);

export interface ReconciliationRun {
  periodStart: string;
  periodEnd: string;
  remoteOrderCount: number;
  remoteTotalRial: string;
  localOrderCount: number;
  localTotalRial: string;
  differenceRial: string;
  inBalance: boolean;
}

async function remoteTotals(
  connection: ConnectionRow,
  after: string,
  before: string,
): Promise<{ count: number; totalRial: bigint }> {
  const client = wooClientFor(connection);
  let count = 0;
  let totalRial = 0n;
  let page = 1;
  for (;;) {
    const orders = await client.listOrders({ after, before, per_page: 100, page, status: "completed,processing" });
    for (const order of orders) {
      if (!REMOTE_STATUSES.has(order.status)) continue;
      count += 1;
      totalRial += wooAmountToRial(order.total ?? "0", connection.currency_unit);
    }
    if (orders.length < 100) break;
    page += 1;
  }
  return { count, totalRial };
}

async function localTotals(
  businessId: string,
  after: string,
  before: string,
): Promise<{ count: number; totalRial: bigint }> {
  const { rows } = await query<{ count: string; total: string }>(
    `SELECT count(DISTINCT je.id) AS count, COALESCE(SUM(jl.debit), 0)::text AS total
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.business_id = $1
        AND je.source_type = 'woocommerce_order'
        AND je.entry_date >= $2::date AND je.entry_date < $3::date`,
    [businessId, after, before],
  );
  return { count: Number(rows[0]?.count ?? 0), totalRial: BigInt(rows[0]?.total ?? "0") };
}

export async function runReconciliation(
  businessId: string,
  connectionId: string,
  createdBy: string,
  periodStart: string,
  periodEnd: string,
): Promise<ReconciliationRun | null> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) return null;

  const [remote, local] = await Promise.all([
    remoteTotals(connection, periodStart, periodEnd),
    localTotals(businessId, periodStart, periodEnd),
  ]);
  const result = reconcileTotals({
    remoteOrderCount: remote.count,
    remoteTotalRial: remote.totalRial,
    localOrderCount: local.count,
    localTotalRial: local.totalRial,
  });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO integration_reconciliations
       (business_id, connection_id, period_start, period_end,
        remote_order_count, remote_total_rial, local_order_count, local_total_rial, difference_rial, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      businessId,
      connectionId,
      periodStart,
      periodEnd,
      result.remoteOrderCount,
      result.remoteTotalRial.toString(),
      result.localOrderCount,
      result.localTotalRial.toString(),
      result.differenceRial.toString(),
      createdBy,
    ],
  );

  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "reconciliation.run",
    payload: {
      id: rows[0].id,
      inBalance: result.inBalance,
      differenceRial: result.differenceRial.toString(),
    },
  });

  return {
    periodStart,
    periodEnd,
    remoteOrderCount: result.remoteOrderCount,
    remoteTotalRial: result.remoteTotalRial.toString(),
    localOrderCount: result.localOrderCount,
    localTotalRial: result.localTotalRial.toString(),
    differenceRial: result.differenceRial.toString(),
    inBalance: result.inBalance,
  };
}

export async function listReconciliations(
  businessId: string,
  connectionId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await query(
    `SELECT id, period_start, period_end, remote_order_count, remote_total_rial,
            local_order_count, local_total_rial, difference_rial, status, created_at
       FROM integration_reconciliations
      WHERE business_id = $1 AND connection_id = $2
      ORDER BY created_at DESC
      LIMIT 50`,
    [businessId, connectionId],
  );
  return rows;
}
