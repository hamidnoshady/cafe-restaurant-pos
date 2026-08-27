/**
 * Phase 26 (issue #125) Wave 6 — rollback of one import run.
 *
 * Keyed on `integration_mappings.import_run_id` (stamped by Waves 3–5), so only
 * the rows *this* run created are reverted, in FK-safe order, inside one
 * transaction. If a created row has since been referenced by real user data
 * (e.g. a customer now has an order), the RESTRICT foreign keys make the
 * transaction fail loudly rather than cascade into data the run did not make —
 * which is the safe failure mode.
 *
 * Order matters: journal_lines → journal_entries → accounts → items/menu_items
 * → customers/suppliers. (journal_lines → accounts is RESTRICT, so the journal
 * must go before the accounts.)
 */
import { getPool, query } from "../../db";
import { markRunRolledBack } from "./migration-run-service";

interface RunMapping extends Record<string, unknown> {
  entity_type: string;
  local_id: string;
}

export interface RollbackResult {
  runId: string;
  reverted: Record<string, number>;
}

export async function rollbackImportRun(businessId: string, runId: string): Promise<RollbackResult> {
  const { rows } = await query<RunMapping>(
    `SELECT entity_type, local_id FROM integration_mappings
      WHERE business_id = $1 AND import_run_id = $2`,
    [businessId, runId],
  );
  const ids = (type: string) => rows.filter((r) => r.entity_type === type).map((r) => r.local_id);

  const reverted: Record<string, number> = {};
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // Journal entries (their lines cascade via ON DELETE CASCADE).
    const journalIds = ids("holoo_journal");
    if (journalIds.length) {
      const { rowCount } = await client.query(
        `DELETE FROM journal_entries WHERE id = ANY($1::uuid[]) AND business_id = $2`,
        [journalIds, businessId],
      );
      reverted.holoo_journal = rowCount ?? 0;
    }

    // Accounts (journal_lines already gone; parent_id self-ref is SET NULL).
    const accountIds = ids("holoo_account");
    if (accountIds.length) {
      const { rowCount } = await client.query(
        `DELETE FROM accounts WHERE id = ANY($1::uuid[]) AND business_id = $2`,
        [accountIds, businessId],
      );
      reverted.holoo_account = rowCount ?? 0;
    }

    // Goods — could be menu_items (food service) or items (retail).
    const goodsIds = ids("holoo_goods");
    if (goodsIds.length) {
      const menu = await client.query(`DELETE FROM menu_items WHERE id = ANY($1::uuid[])`, [goodsIds]);
      const retail = await client.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [goodsIds]);
      reverted.holoo_goods = (menu.rowCount ?? 0) + (retail.rowCount ?? 0);
    }

    // Persons — customers or suppliers.
    const personIds = ids("holoo_customer");
    if (personIds.length) {
      const cust = await client.query(`DELETE FROM customers WHERE id = ANY($1::uuid[]) AND business_id = $2`, [personIds, businessId]);
      const sup = await client.query(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [personIds]);
      reverted.holoo_customer = (cust.rowCount ?? 0) + (sup.rowCount ?? 0);
    }

    // Drop the mapping rows for this run last.
    await client.query(
      `DELETE FROM integration_mappings WHERE business_id = $1 AND import_run_id = $2`,
      [businessId, runId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await markRunRolledBack(businessId, runId);
  return { runId, reverted };
}
