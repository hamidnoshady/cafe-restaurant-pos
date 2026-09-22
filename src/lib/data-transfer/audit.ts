/**
 * The engine's audit trail.
 *
 * Every import and every export is written to `audit_log` — the business's own
 * security log, which already has a reader (`/settings/audit-log`), an RLS
 * policy and a retention story. A second, private log for this one module
 * would be a place nobody looks.
 *
 * A bulk read or write of a business's data is a privacy event, so the row
 * records who, when, which entity, which file, how many rows and what came of
 * them. That is the requirement; keeping it in the platform's existing log is
 * how it stays discoverable.
 *
 * The write is **error-swallowing**, the same rule `recordCrmAudit` follows: an
 * audit row is evidence about an operation, not the operation, and an import
 * that rolled back because its log line failed would be a far worse bug than a
 * missing log line.
 */

import { query } from "../db";

export interface DataTransferAuditInput {
  businessId: string;
  /** `data.import.created`, `data.import.completed`, `data.export.completed`, … */
  action: string;
  entityKey: string;
  /** The job's id, so the log row links to the history entry. */
  entityId: string | null;
  actorUserId: string | null;
  payload?: Record<string, unknown>;
}

export async function recordDataTransferAudit(input: DataTransferAuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb)`,
      [
        input.businessId,
        input.actorUserId,
        input.action,
        input.entityKey,
        input.entityId,
        JSON.stringify(input.payload ?? {}),
      ],
    );
  } catch (error) {
    console.error("data-transfer audit write failed", input.action, error);
  }
}
