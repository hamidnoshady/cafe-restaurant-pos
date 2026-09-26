/**
 * Central Billing responses the CMS outbox may consume.
 */

export type BatchAckStatus = "accepted" | "duplicate" | "rejected";

export function parseBatchAck(body: unknown): { error: string } | { results: { eventId: string; status: BatchAckStatus; reason: string | null }[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "ack is not an object" };
  const raw = body as { contractVersion?: unknown; results?: unknown };
  if (raw.contractVersion !== undefined && raw.contractVersion !== 1) {
    return { error: "ack contractVersion is not supported" };
  }
  const results = raw.results;
  if (!Array.isArray(results)) return { error: "ack has no results" };
  const parsed: { eventId: string; status: BatchAckStatus; reason: string | null }[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const row = item as { eventId?: unknown; reason?: unknown; status?: unknown };
    if (typeof row.eventId !== "string" || !row.eventId) continue;
    if (row.status !== "accepted" && row.status !== "duplicate" && row.status !== "rejected") continue;
    parsed.push({
      eventId: row.eventId,
      status: row.status,
      reason: typeof row.reason === "string" ? row.reason.slice(0, 500) : null,
    });
  }
  return { results: parsed };
}
