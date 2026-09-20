-- Phase F (Projects as workspaces), Part 3 — project tasks.
--
-- Part 1 gave a project model-visible MEMORY (standing facts) and Part 2 let the
-- assistant write it through a confirmed action. Both memory and notes are
-- STATELESS — a fact is simply true, a note simply exists. A project workspace
-- also needs the one thing they lack: a unit of work with a LIFECYCLE.
--
-- A task is "something to do for this project" that is open until it is done:
-- "call the roaster about the spring blend", "draft the Nowruz discount". It has
-- exactly two states (open -> done) — no assignee, no due date, no priority yet;
-- those are an operational layer that earns its columns only once a project has
-- people and deadlines hanging off it (the same restraint migration 0111 showed
-- by deferring status/owner/budget until Phase 37).
--
-- Like memory, a task carries provenance: 'user' when a person added it on the
-- project page, 'ai' when the assistant proposed it and a human confirmed. OPEN
-- tasks feed the project's prompt context (so the assistant knows what is still
-- outstanding); done tasks drop out of it but stay for the record.
--
-- It reaches tenant scope through its parent ai_projects row — exactly like
-- ai_project_notes (0111) and ai_project_memory (0158) — so it needs no
-- business_id of its own. Additive: no existing table is touched.

CREATE TABLE ai_project_tasks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
    -- The thing to do. Kept short by the service (a task is a line, not a doc).
    title           text NOT NULL,
    status          text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'done')),
    -- Provenance: 'user' from the project page, 'ai' from a confirmed proposal.
    -- Not a tenant boundary (RLS is) — an authorship label shown in the UI.
    source          text NOT NULL DEFAULT 'user'
                        CHECK (source IN ('user', 'ai')),
    -- The user id of the author (a person, or the actor a confirmed AI write
    -- ran as). Text to match ai_project_notes.created_by / ai_project_memory.
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- When it moved to 'done'. NULL while open.
    completed_at    timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_project_tasks_project_created
    ON ai_project_tasks (project_id, created_at DESC);
-- The common read is "the still-open tasks for this project" (for the prompt
-- context and the top of the task list).
CREATE INDEX idx_ai_project_tasks_open
    ON ai_project_tasks (project_id) WHERE status = 'open';

-- RLS: reach tenant scope through the parent project, exactly like
-- ai_project_memory (0158) and ai_project_notes (0111).
ALTER TABLE ai_project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_project_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_project_tasks FOR ALL
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
