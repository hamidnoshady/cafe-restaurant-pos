-- Phase E (structured chat input protocol) — the durable record of a
-- `request_input` turn.
--
-- Before this, an assistant turn ended in exactly two ways: plain text, or a
-- `propose_action` write proposal (stored on ai_messages.proposal). This table
-- adds the third: a typed INPUT REQUEST — a small validated form spec the model
-- emits ("which of these suppliers?", "fill in the missing amount") that the UI
-- renders as a card and the user answers with structured data.
--
-- Why its own table rather than another jsonb column on ai_messages:
--   * a request has a LIFECYCLE (pending -> answered / cancelled) that a chat
--     message does not — the card must know whether it was already answered so a
--     re-render, a second browser tab, or a page reload cannot submit twice;
--   * the answer is validated against the very spec the model emitted, so both
--     the spec AND the response must be stored together to re-validate on submit;
--   * it links to the assistant message that carried it, so the transcript and
--     the request stay in one join.
--
-- It reaches tenant scope the same way ai_messages does — through its parent
-- ai_conversations row — since a conversation is owned by one actor within one
-- business (see migration 0046). No business_id of its own.
--
-- Additive: no existing table is touched.

CREATE TABLE ai_input_requests (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    -- The assistant message this request was attached to (the turn that asked).
    -- NULL only for a request created outside a persisted conversation.
    message_id          uuid REFERENCES ai_messages(id) ON DELETE SET NULL,
    -- 'choice' | 'multi_choice' | 'form', mirrored from the validated spec.
    kind                text NOT NULL CHECK (kind IN ('choice', 'multi_choice', 'form')),
    -- The validated form spec the model emitted (bounded + type-checked in
    -- ai-input-protocol.ts before it is ever written here).
    spec                jsonb NOT NULL,
    status              text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'answered', 'cancelled')),
    -- The user's validated answer; NULL until answered. Re-validated against
    -- `spec` on submit — a stored response always fits the question asked.
    response            jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    answered_at         timestamptz
);

CREATE INDEX idx_ai_input_requests_conversation
    ON ai_input_requests (conversation_id, created_at DESC);
-- The common lookup is "the still-open request(s) for this conversation".
CREATE INDEX idx_ai_input_requests_pending
    ON ai_input_requests (conversation_id) WHERE status = 'pending';

ALTER TABLE ai_input_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_input_requests FORCE ROW LEVEL SECURITY;
-- Same shape as ai_messages: reach tenant scope through the parent conversation.
CREATE POLICY tenant_isolation ON ai_input_requests FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (
            SELECT 1 FROM ai_conversations c
             WHERE c.id = conversation_id AND c.business_id = app_current_business()
        )
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (
            SELECT 1 FROM ai_conversations c
             WHERE c.id = conversation_id AND c.business_id = app_current_business()
        )
    );
