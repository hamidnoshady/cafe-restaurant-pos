/**
 * Phase 20 Wave 6 — audit trail: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why;
 * the pure label/lookup rules it uses live in audit.ts and are covered by
 * audit.test.ts).
 *
 * `audit_log` (Phase 0) and its RLS policy already exist and already cover
 * every business — this wave only adds a reader, so it needs no migration.
 */
import { query } from "./db";

export interface AuditEntry {
  id: number;
  businessId: string;
  locationId: string | null;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
  /** Resolved from the payload's credentialId, for an `employee.session_created` row (Wave 5's first open question). */
  credentialType: string | null;
  /** Resolved from the payload's deviceId, for a row whose payload names one. */
  deviceLabel: string | null;
  /** Resolved from entity_id for an `entity = 'employee'` row (e.g. `employee.login_failed`, Wave 7) — the actor column is null for a pre-authentication failure, so this is the only way to say whose attempt it was. */
  entityName: string | null;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  user_id: string | null;
  actor_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  payload: unknown;
  created_at: Date;
  credential_type: string | null;
  device_label: string | null;
  entity_name: string | null;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    businessId: row.business_id,
    locationId: row.location_id,
    actorId: row.user_id,
    actorName: row.actor_name,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    credentialType: row.credential_type,
    deviceLabel: row.device_label,
    entityName: row.entity_name,
  };
}

export interface AuditLogFilters {
  entity?: string;
  actorId?: string;
  /** Wave 7 — narrows to one action, e.g. `employee.login_failed` for the security center's failed-attempts list, without the caller needing the broader entity filter's noise. */
  action?: string;
  /** Rows with id strictly less than this — the same "most recent first" cursor listShifts's LIMIT gets away without, but a security log is expected to grow past 200 rows quickly. */
  before?: number;
  limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * The business's audit trail, most recent first — every action any wave of
 * this phase (and team-service.ts/branch-service.ts from earlier phases)
 * already writes to `audit_log`, now actually readable by an owner/manager.
 *
 * `credential_type`/`device_label` are resolved live via a join keyed off the
 * ids embedded in `payload` (only `employee.session_created` rows carry
 * them) rather than duplicated at write time, so a credential revoked or a
 * device renamed after the fact is reflected here without a backfill.
 *
 * `entity_name` (Wave 7) is resolved the same live way, but off `entity_id`
 * directly rather than a payload field — it's what lets the security
 * center's failed-login list say *whose* attempt it was even though
 * `employee.login_failed` rows have no actor (nothing was authenticated yet).
 */
export async function listAuditLog(
  businessId: string,
  filters: AuditLogFilters = {},
): Promise<AuditEntry[]> {
  const params: unknown[] = [businessId];
  const conditions: string[] = ["a.business_id = $1"];
  if (filters.entity) {
    params.push(filters.entity);
    conditions.push(`a.entity = $${params.length}`);
  }
  if (filters.actorId) {
    params.push(filters.actorId);
    conditions.push(`a.user_id = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    conditions.push(`a.action = $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    conditions.push(`a.id < $${params.length}`);
  }
  const requestedLimit = Number.isFinite(filters.limit) ? (filters.limit as number) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
  params.push(limit);

  const { rows } = await query<AuditRow>(
    `SELECT a.id, a.business_id, a.location_id, a.user_id, u.full_name AS actor_name,
            a.action, a.entity, a.entity_id, a.payload, a.created_at,
            ec.credential_type::text AS credential_type,
            d.label AS device_label,
            eu.full_name AS entity_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN employee_credentials ec
              ON ec.business_id = a.business_id
             AND ec.id = nullif(a.payload->>'credentialId', '')::uuid
       LEFT JOIN pos_devices d
              ON d.business_id = a.business_id
             AND d.id = nullif(a.payload->>'deviceId', '')::uuid
       LEFT JOIN users eu
              ON a.entity = 'employee'
             AND eu.id = nullif(a.entity_id, '')::uuid
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toEntry);
}
