/**
 * Phase E — persistence and lifecycle for the structured chat input protocol.
 *
 * The database half of `ai-input-protocol.ts`. A `request_input` turn creates
 * one row here (status `pending`); the card the user sees submits an answer that
 * is RE-VALIDATED against the stored spec here (never trusting the client to
 * have validated it) before the request is marked `answered`. The pure spec/
 * response validation lives in `ai-input-protocol.ts` and is unit-tested there;
 * this file owns tenant scope, the lifecycle transition, and the join to the
 * conversation transcript.
 */
import { query } from "./db";
import {
  validateInputResponse,
  formatInputResponseForModel,
  type InputRequestSpec,
  type InputResponse,
  type InputRequestKind,
} from "./ai-input-protocol";

export interface AiInputRequest {
  id: string;
  conversationId: string;
  messageId: string | null;
  kind: InputRequestKind;
  spec: InputRequestSpec;
  status: "pending" | "answered" | "cancelled";
  response: InputResponse | null;
  createdAt: string;
  answeredAt: string | null;
}

interface Row extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  message_id: string | null;
  kind: string;
  spec: InputRequestSpec;
  status: string;
  response: InputResponse | null;
  created_at: string;
  answered_at: string | null;
}

function toRequest(row: Row): AiInputRequest {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    kind: row.kind as InputRequestKind,
    spec: row.spec,
    status: row.status as AiInputRequest["status"],
    response: row.response,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

const COLUMNS =
  "id, conversation_id, message_id, kind, spec, status, response, created_at::text AS created_at, answered_at::text AS answered_at";

/**
 * Record a validated input request against a conversation turn. `spec` must
 * already have passed `validateInputRequest` — the caller (the chat route) does
 * that so a malformed request never reaches the DB.
 */
export async function createInputRequest(input: {
  conversationId: string;
  messageId: string | null;
  spec: InputRequestSpec;
}): Promise<AiInputRequest> {
  const { rows } = await query<Row>(
    `INSERT INTO ai_input_requests (conversation_id, message_id, kind, spec)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${COLUMNS}`,
    [input.conversationId, input.messageId, input.spec.kind, JSON.stringify(input.spec)],
  );
  return toRequest(rows[0]);
}

export async function getInputRequest(
  conversationId: string,
  id: string,
): Promise<AiInputRequest | null> {
  const { rows } = await query<Row>(
    `SELECT ${COLUMNS} FROM ai_input_requests WHERE id = $1 AND conversation_id = $2`,
    [id, conversationId],
  );
  return rows[0] ? toRequest(rows[0]) : null;
}

/** Every still-open request for a conversation (usually zero or one). */
export async function listPendingInputRequests(conversationId: string): Promise<AiInputRequest[]> {
  const { rows } = await query<Row>(
    `SELECT ${COLUMNS} FROM ai_input_requests
      WHERE conversation_id = $1 AND status = 'pending'
      ORDER BY created_at`,
    [conversationId],
  );
  return rows.map(toRequest);
}

export type AnswerInputResult =
  | { ok: true; request: AiInputRequest; modelMessage: string }
  | { ok: false; error: string; details?: string[] };

/**
 * Answer a pending input request. Re-validates the submitted response against
 * the stored spec (never the client's word for it), records it, and returns the
 * plain-text message to feed the model as the user's next turn — labels, not
 * ids, so the model reads what the user actually saw.
 *
 * The status transition is atomic and guarded: the UPDATE only fires WHERE the
 * row is still `pending`, so a double submit (second tab, reload, retry) that
 * loses the race changes nothing and reports `already_answered` rather than
 * writing a second answer or re-triggering the model.
 */
export async function answerInputRequest(input: {
  conversationId: string;
  id: string;
  response: unknown;
}): Promise<AnswerInputResult> {
  const request = await getInputRequest(input.conversationId, input.id);
  if (!request) return { ok: false, error: "not_found" };
  if (request.status !== "pending") return { ok: false, error: "already_answered" };

  const validation = validateInputResponse(request.spec, input.response);
  if (!validation.ok) return { ok: false, error: "invalid_response", details: validation.errors };

  const { rows } = await query<Row>(
    `UPDATE ai_input_requests
        SET status = 'answered', response = $3::jsonb, answered_at = now()
      WHERE id = $1 AND conversation_id = $2 AND status = 'pending'
      RETURNING ${COLUMNS}`,
    [input.id, input.conversationId, JSON.stringify(validation.response)],
  );
  // Lost the race to a concurrent submit — the row is no longer pending.
  if (!rows[0]) return { ok: false, error: "already_answered" };

  return {
    ok: true,
    request: toRequest(rows[0]),
    modelMessage: formatInputResponseForModel(request.spec, validation.response),
  };
}

/**
 * Cancel a pending request (the user dismissed the card without answering).
 * Idempotent: a request that is already answered or cancelled is left as-is.
 */
export async function cancelInputRequest(conversationId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE ai_input_requests SET status = 'cancelled'
      WHERE id = $1 AND conversation_id = $2 AND status = 'pending'`,
    [id, conversationId],
  );
  return (rowCount ?? 0) > 0;
}
