-- Phase F (Projects as workspaces), Part 1 — project memory.
--
-- Until now a project carried three things the assistant could, in principle,
-- read: a name, a standing `instructions` string, and a list of NOTES. The
-- catch (audit §1.5): none of it ever reached the model. `buildProjectPromptContext`,
-- `getConversationProjectId` and `listConversationsByProject` were all written
-- for "prompt injection" and then never called, so a project was a folder that
-- grouped threads and nothing more — it did not shape a single reply.
--
-- Phase F turns a project into a WORKSPACE. Part 1 does two things:
--   1. wires the existing project instructions + notes into every turn whose
--      conversation belongs to a project (code-only, no schema);
--   2. adds this table — durable, model-visible MEMORY.
--
-- Memory vs notes: a NOTE is authored by a human on the project page (a plan, a
-- decision, a reference). A MEMORY entry is a short, standing fact the assistant
-- is told to remember for this project ("the owner prefers Toman rounded to the
-- nearest thousand", "this campaign targets lapsed lunch customers") — it can be
-- written by the assistant through a confirmed action, or by a human. Both feed
-- the project's prompt context; keeping them in separate tables keeps a
-- human-curated note list from being churned by the model, and lets memory carry
-- its own provenance (who/what wrote it) and an ordering key.
--
-- It reaches tenant scope through its parent ai_projects row — exactly like
-- ai_project_notes does (migration 0111) — so it needs no business_id of its
-- own. Additive: no existing table is touched.

CREATE TABLE ai_project_memory (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
    -- The remembered fact. Kept short by the service (a memory is a fact, not a
    -- document — long context belongs in a note or, later, a project file).
    content         text NOT NULL,
    -- Provenance: 'user' when a person added it from the project page, 'ai' when
    -- the assistant wrote it through a confirmed action. This is not a tenant
    -- boundary (RLS is), it is an audit/authorship label shown in the UI.
    source          text NOT NULL DEFAULT 'user'
                        CHECK (source IN ('user', 'ai')),
    -- The user id of the author (a person, or the actor a confirmed AI write ran
    -- as). Text to match ai_project_notes.created_by / ai_projects.created_by.
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_project_memory_project_created
    ON ai_project_memory (project_id, created_at DESC);

-- RLS: reach tenant scope through the parent project, exactly like
-- ai_project_notes reaches it (migration 0111), which is itself the same shape
-- as ai_messages reaching it through ai_conversations.
ALTER TABLE ai_project_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_project_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_project_memory FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (
            SELECT 1 FROM ai_projects p
             WHERE p.id = project_id AND p.business_id = app_current_business()
        )
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (
            SELECT 1 FROM ai_projects p
             WHERE p.id = project_id AND p.business_id = app_current_business()
        )
    );
