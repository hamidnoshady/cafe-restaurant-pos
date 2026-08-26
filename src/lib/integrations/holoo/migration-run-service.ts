/**
 * Phase 26 (issue #125) Wave 6 — import-run lifecycle for the migration wizard.
 *
 * An "apply" is one import run: it opens a `holoo_import_runs` row, stamps that
 * id on every mapping it writes, and is marked completed (or rolled back). This
 * module owns the run rows; rollback-service.ts owns the reversal.
 */
import { query } from "../../db";

export async function beginImportRun(
  businessId: string,
  connectionId: string,
  createdBy: string | null,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO holoo_import_runs (business_id, connection_id, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [businessId, connectionId, createdBy],
  );
  return rows[0].id;
}

export async function completeImportRun(
  businessId: string,
  runId: string,
  summary: unknown,
): Promise<void> {
  await query(
    `UPDATE holoo_import_runs SET status = 'completed', summary = $3
      WHERE business_id = $1 AND id = $2`,
    [businessId, runId, JSON.stringify(summary)],
  );
}

export async function markRunRolledBack(businessId: string, runId: string): Promise<void> {
  await query(
    `UPDATE holoo_import_runs SET status = 'rolled_back'
      WHERE business_id = $1 AND id = $2`,
    [businessId, runId],
  );
}

export interface ImportRunRow {
  id: string;
  status: "running" | "completed" | "rolled_back";
  summary: unknown;
  createdAt: string;
}

export async function listImportRuns(businessId: string, connectionId: string): Promise<ImportRunRow[]> {
  const { rows } = await query<{ id: string; status: "running" | "completed" | "rolled_back"; summary: unknown; created_at: string }>(
    `SELECT id, status, summary, created_at FROM holoo_import_runs
      WHERE business_id = $1 AND connection_id = $2
      ORDER BY created_at DESC`,
    [businessId, connectionId],
  );
  return rows.map((r) => ({ id: r.id, status: r.status, summary: r.summary, createdAt: r.created_at }));
}
