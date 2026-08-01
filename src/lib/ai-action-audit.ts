/**
 * Phase 18b Wave 5 — tenant-scoped audit records for the human-confirmed
 * proposal path. The record is created server-side when a proposal is returned,
 * then the UI marks its final human decision after the already-guarded endpoint
 * succeeds or is dismissed.
 */
import { query } from "./db";
import type { ProposedAction } from "./ai";

export type AiActionAuditStatus = "proposed" | "applied" | "failed" | "dismissed";

export interface AiActionAuditEntry {
  id: string;
  actorUserId: string;
  actorName: string;
  promptExcerpt: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  status: AiActionAuditStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
}

function compactAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactAuditValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key.slice(0, 100), compactAuditValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 500);
}

function jsonValue(value: unknown): string {
  return JSON.stringify(compactAuditValue(value));
}

export async function createAiActionAudit(input: {
  businessId: string;
  actorUserId: string;
  actorName: string | null | undefined;
  prompt: string;
  proposal: ProposedAction;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_action_audit
       (business_id, actor_user_id, actor_name, prompt_excerpt, action_type, action_title, action_summary, proposal_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      input.businessId,
      input.actorUserId,
      input.actorName?.trim().slice(0, 200) ?? "",
      input.prompt.trim().slice(0, 1_500),
      input.proposal.type,
      input.proposal.title.trim().slice(0, 500),
      input.proposal.summary.trim().slice(0, 2_000),
      jsonValue(input.proposal.payload),
    ],
  );
  if (!rows[0]) throw new Error("ai_action_audit_create_failed");
  return rows[0].id;
}

export async function listAiActionAudit(businessId: string, limit = 30): Promise<AiActionAuditEntry[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { rows } = await query<AiActionAuditEntry>(
    `SELECT id,
            actor_user_id AS "actorUserId",
            actor_name AS "actorName",
            prompt_excerpt AS "promptExcerpt",
            action_type AS "actionType",
            action_title AS "actionTitle",
            action_summary AS "actionSummary",
            proposal_payload AS payload,
            status,
            result,
            created_at AS "createdAt",
            applied_at AS "appliedAt"
       FROM ai_action_audit
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, safeLimit],
  );
  return rows;
}

export async function finishAiActionAudit(input: {
  businessId: string;
  id: string;
  status: Exclude<AiActionAuditStatus, "proposed">;
  result?: Record<string, unknown>;
}): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_action_audit
        SET status = $3,
            result = $4::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
    [input.id, input.businessId, input.status, jsonValue(input.result ?? {})],
  );
  return (rowCount ?? 0) > 0;
}
