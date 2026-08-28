-- ============================================================================
-- 0111_ai_projects.sql — Phase 35 Wave 3 (issue #361)
-- Projects: target folders that group AI conversations, notes and a static
-- instruction. A project is a "folder with purpose" — threads, notes and a
-- standing instruction that shapes the assistant's behavior in those threads.
--
-- Status/owner/budget and cost-center dimension are deliberately absent: they
-- land in Phase 37, when a marketing campaign has spend to report on. Building
-- an operational object before anything hangs off it would produce a table of
-- empty columns.
-- ============================================================================

-- The project itself.
CREATE TABLE ai_projects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name            text NOT NULL,
    instructions    text NOT NULL DEFAULT '',
    created_by      text NOT NULL,
    archived_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_projects_business_name
    ON ai_projects (business_id, name);

-- Notes attached to a project. Follows the same pattern as ai_messages:
-- no business_id of its own; reaches tenant scope through the parent project.
CREATE TABLE ai_project_notes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
    title           text NOT NULL DEFAULT '',
    content         text NOT NULL DEFAULT '',
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_project_notes_project_created
    ON ai_project_notes (project_id, created_at);

-- Link conversations to projects. ON DELETE SET NULL so archiving/deleting
-- a project does not destroy the conversation history.
ALTER TABLE ai_conversations
    ADD COLUMN project_id uuid NULL REFERENCES ai_projects(id) ON DELETE SET NULL;
CREATE INDEX idx_ai_conversations_project
    ON ai_conversations (project_id) WHERE project_id IS NOT NULL;

-- RLS: ai_projects is tenant-scoped directly.
ALTER TABLE ai_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_projects FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- RLS: ai_project_notes reaches tenant scope through its parent project,
-- exactly like ai_messages reaches it through ai_conversations.
ALTER TABLE ai_project_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_project_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_project_notes FOR ALL
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
