/**
 * Phase 21 Wave 1 — domain-event log + posting-rule engine.
 *
 * Today, every auto-posted journal entry (order payment, purchase receipt,
 * waste, ...) is produced by its own dedicated function hand-written in
 * ledger-service.ts/inventory-service.ts. That doesn't scale to a second,
 * third, and fourth industry each with their own sale/repair/consignment
 * events. This module is the alternative: a business event is recorded once
 * into `domain_events`, generically, and a *registered* posting rule turns
 * it into a balanced journal entry via the existing `postJournalEntry()` —
 * so a new industry's posting logic is a rule registration, not a new copy
 * of ledger code.
 *
 * Deliberately not wired to F&B's existing posting paths yet — those
 * functions are proven and load-bearing; re-pointing them at this engine is
 * its own reviewable follow-up, not bundled into the engine's introduction.
 */
import type { PoolClient } from "pg";
import { postJournalEntry } from "./ledger-service";
import type { JournalLine } from "./ledger";

export interface DomainEvent {
  id: string;
  businessId: string;
  locationId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  sourceType: string | null;
  sourceId: string | null;
  entryId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface RecordDomainEventInput {
  businessId: string;
  locationId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  sourceType?: string | null;
  sourceId?: string | null;
  createdBy?: string | null;
}

/** What a posting rule hands back for the engine to post; `null` means "record the event, post nothing" (not every domain event has a ledger effect). */
export interface PostingResult {
  lines: JournalLine[];
  /** ISO date (YYYY-MM-DD); defaults to today, same as postJournalEntry. */
  entryDate?: string | null;
  memo?: string | null;
}

export type PostingRule = (event: DomainEvent) => Promise<PostingResult | null>;

const rules = new Map<string, PostingRule>();

/**
 * Register the posting rule for an event type. An industry module calls this
 * once (e.g. at import time) to teach the engine how to turn its own events
 * into journal entries. Registering the same event type again replaces the
 * previous rule.
 */
export function registerPostingRule(eventType: string, rule: PostingRule): void {
  rules.set(eventType, rule);
}

/** Whether a rule is currently registered for this event type. */
export function hasPostingRule(eventType: string): boolean {
  return rules.has(eventType);
}

/** Test-only: clear every registered rule between test cases. */
export function resetPostingRulesForTest(): void {
  rules.clear();
}

interface DomainEventRow {
  id: string;
  business_id: string;
  location_id: string | null;
  event_type: string;
  payload: unknown;
  source_type: string | null;
  source_id: string | null;
  entry_id: string | null;
  created_by: string | null;
  created_at: string;
}

function mapEventRow(row: DomainEventRow): DomainEvent {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    eventType: row.event_type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    sourceType: row.source_type,
    sourceId: row.source_id,
    entryId: row.entry_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Appends one event to the log. Always succeeds regardless of whether a posting rule exists for it. */
export async function recordDomainEvent(
  client: PoolClient,
  input: RecordDomainEventInput,
): Promise<DomainEvent> {
  const { rows } = await client.query<DomainEventRow>(
    `INSERT INTO domain_events (business_id, location_id, event_type, payload, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.businessId,
      input.locationId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
      input.sourceType ?? null,
      input.sourceId ?? null,
      input.createdBy ?? null,
    ],
  );
  return mapEventRow(rows[0]);
}

/**
 * Looks up the registered rule for this event's type and, if one exists,
 * posts a balanced journal entry for it (via postJournalEntry, so it's
 * subject to the fiscal-period lock and every other posting-path invariant
 * exactly like every existing auto-posted entry) and stamps
 * `domain_events.entry_id`. No rule registered, or the rule returns `null`
 * or no lines, is not an error — it just means this event has no ledger
 * effect. Returns the posted entry id, or null if nothing was posted.
 */
export async function dispatchDomainEvent(
  client: PoolClient,
  event: DomainEvent,
): Promise<string | null> {
  const rule = rules.get(event.eventType);
  if (!rule) return null;

  const result = await rule(event);
  if (!result || result.lines.length === 0) return null;

  const entryId = await postJournalEntry(client, {
    businessId: event.businessId,
    locationId: event.locationId,
    entryDate: result.entryDate ?? null,
    memo: result.memo ?? null,
    sourceType: event.sourceType ?? event.eventType,
    sourceId: event.sourceId,
    lines: result.lines,
    createdBy: event.createdBy,
  });

  if (entryId) {
    await client.query(`UPDATE domain_events SET entry_id = $1 WHERE id = $2`, [entryId, event.id]);
  }
  return entryId;
}

/** Convenience: record then dispatch, in the caller's own transaction. */
export async function emitDomainEvent(
  client: PoolClient,
  input: RecordDomainEventInput,
): Promise<{ event: DomainEvent; entryId: string | null }> {
  const event = await recordDomainEvent(client, input);
  const entryId = await dispatchDomainEvent(client, event);
  return { event: entryId ? { ...event, entryId } : event, entryId };
}
