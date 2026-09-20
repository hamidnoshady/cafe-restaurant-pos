/**
 * The CRM's audit trail — a narrow log of decisions a person may have to
 * explain.
 *
 * ## What this is not
 *
 * It is **not** a generic event bus, and it is deliberately not a second copy
 * of the timeline. The customer timeline is a *mapping* over the tables that
 * already own each fact (`customer-timeline-service.ts`), and that stays true:
 * an order is shown by reading `orders`, not by reading a copy of an order.
 *
 * What the timeline cannot answer is "who decided this, and why". A stage
 * moved from Proposal to Lost; a lead was converted onto an existing customer
 * rather than a new one; an ambiguous WooCommerce identity was resolved onto
 * this party. Those are *judgements*, they leave no natural row behind, and
 * six months later somebody will ask. That is the whole scope of this table.
 *
 * ## The rules
 *
 * - **Append-only.** Nothing in the app issues an UPDATE or DELETE against it.
 * - **Stable actor ids where they exist.** `actor_user_id` is the membership;
 *   `actor_name` is the display-name snapshot beside it, because a name may be
 *   corrected later and the audit must still read as it did.
 * - **Never on the critical path.** `recordCrmAudit` swallows its own failure.
 *   A merge, a conversion or a consent change must not fail because the audit
 *   insert did — the operation is what the user asked for, and losing an audit
 *   row is a smaller harm than losing the operation. Consent is the one
 *   exception, and it has its own dedicated append-only table
 *   (`crm_consent_events`) written transactionally with the change.
 */

import { query } from "./db";

/**
 * The kinds of decision worth recording. A closed vocabulary rather than free
 * text so reports and filters can be written against it.
 */
export const CRM_AUDIT_KINDS = [
  "lead.created",
  "lead.status_changed",
  "lead.converted",
  "deal.created",
  "deal.stage_changed",
  "deal.owner_changed",
  "deal.sales_document_linked",
  "case.created",
  "case.status_changed",
  "case.assigned",
  "case.reopened",
  "consent.changed",
  "party.merged",
  "party.owner_changed",
  "external.reconciled",
  "external.conflict_resolved",
  "segment.changed",
  "import.committed",
  "export.generated",
  // Configuration decisions. A field definition shapes what every record can
  // record, and archiving one stops a question being asked of anybody — worth
  // a name against it even though no customer data moves.
  "custom_field.created",
  "custom_field.archived",
  "relationship.linked",
  "relationship.unlinked",
] as const;

export type CrmAuditKind = (typeof CRM_AUDIT_KINDS)[number];

export function isCrmAuditKind(value: unknown): value is CrmAuditKind {
  return typeof value === "string" && (CRM_AUDIT_KINDS as readonly string[]).includes(value);
}

export interface CrmAuditInput {
  businessId: string;
  kind: CrmAuditKind;
  entityType:
    | "lead"
    | "deal"
    | "case"
    | "party"
    | "segment"
    | "external_profile"
    | "import"
    | "export"
    | "custom_field"
    | "relationship";
  entityId?: string | null;
  /** The customer this decision was about, when there is one. */
  partyId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  actorUserId?: string | null;
  actorName?: string;
}

/**
 * Append one audit event.
 *
 * Never throws: see the file comment. The caller's operation has already
 * happened (or is about to) and must not be undone by a logging failure.
 */
export async function recordCrmAudit(input: CrmAuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO crm_audit_events
         (business_id, kind, entity_type, entity_id, party_id, summary, detail, actor_user_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        input.businessId,
        input.kind,
        input.entityType,
        input.entityId ?? null,
        input.partyId ?? null,
        input.summary.slice(0, 500),
        JSON.stringify(input.detail ?? {}),
        input.actorUserId ?? null,
        (input.actorName ?? "").slice(0, 120),
      ],
    );
  } catch (error) {
    // Logged, not raised. An audit row is evidence about an operation, not the
    // operation — and a merge that rolled back because its log line failed
    // would be a far worse bug than a missing log line.
    console.error("crm audit write failed", input.kind, error);
  }
}

export interface CrmAuditEvent extends Record<string, unknown> {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  partyId: string | null;
  summary: string;
  detail: Record<string, unknown>;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}

export interface CrmAuditQuery {
  entityType?: string;
  entityId?: string;
  partyId?: string;
  kinds?: readonly string[];
  /** Cursor: only events strictly older than this ISO timestamp. */
  before?: string;
  limit?: number;
}

/**
 * Read the audit trail, newest first, with a cursor.
 *
 * Cursor rather than OFFSET because this table only grows and chronology is
 * the access pattern: `OFFSET 10000` re-reads ten thousand rows to skip them.
 */
export async function listCrmAudit(
  businessId: string,
  options: CrmAuditQuery = {},
): Promise<{ events: CrmAuditEvent[]; nextCursor: string | null }> {
  const params: unknown[] = [businessId];
  let where = "business_id = $1";
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    where += ` AND ${fragment.replace("$n", `$${params.length}`)}`;
  };
  if (options.entityType) add("entity_type = $n", options.entityType);
  if (options.entityId) add("entity_id = $n", options.entityId);
  if (options.partyId) add("party_id = $n", options.partyId);
  if (options.kinds && options.kinds.length > 0) add("kind = ANY($n::text[])", [...options.kinds]);
  if (options.before) add("created_at < $n::timestamptz", options.before);

  // Clamped, not trusted: `limit=999999` on a shared endpoint is how one
  // screen reads a whole table.
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
  params.push(limit + 1);

  const { rows } = await query<CrmAuditEvent>(
    `SELECT id, kind, entity_type AS "entityType", entity_id AS "entityId",
            party_id AS "partyId", summary, detail,
            actor_user_id AS "actorUserId", actor_name AS "actorName",
            created_at AS "createdAt"
       FROM crm_audit_events
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  // One row over the limit answers "is there more" without a second COUNT.
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  return {
    events,
    nextCursor: hasMore ? String(events[events.length - 1]?.createdAt ?? "") || null : null,
  };
}
