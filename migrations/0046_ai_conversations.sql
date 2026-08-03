-- AI Hub Wave 1 (Issue #141) — durable, listable AI assistant conversations.
--
-- The chat route (/api/ai/chat) already reserves/settles credits against the
-- single platform-owned provider config (platform_ai_config, Phase 18) and
-- writes ai_action_audit rows per turn; this migration only adds durable
-- storage for the transcript around that existing flow — no second provider
-- config, no new credit path. Per the product decision for this wave, a
-- conversation is visible only to the actor who started it, not the whole
-- business, so ai_messages has no business_id of its own: its RLS policy
-- (and every application query) reaches tenant scope through its parent
-- ai_conversations row, and ownership (actor_user_id) is enforced by the
-- application layer on top of that, the same way RLS only ever enforces the
-- business boundary and never a within-tenant one.

CREATE TABLE ai_conversations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    actor_user_id       text NOT NULL,
    mode                text NOT NULL CHECK (mode IN ('wizard', 'floor', 'dashboard')),
    title               text NOT NULL DEFAULT '',
    last_message_at     timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_conversations_business_actor_last_message
    ON ai_conversations (business_id, actor_user_id, last_message_at DESC);

CREATE TABLE ai_messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role                text NOT NULL CHECK (role IN ('user', 'assistant')),
    content             text NOT NULL,
    tool_calls          jsonb,
    proposal            jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_conversation_created
    ON ai_messages (conversation_id, created_at);

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_conversations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_messages FOR ALL
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
