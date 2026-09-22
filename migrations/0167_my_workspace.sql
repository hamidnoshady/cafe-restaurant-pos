-- ============================================================================
-- 0167_my_workspace.sql — «پروژه‌ها» becomes «میز کار من» (My Workspace).
--
-- Phase F built a project as an AI workspace: a folder that groups
-- conversations, carries a standing instruction, notes, memory, two-state
-- tasks, a pinned agent and its files (0111, 0143, 0158–0162). That is a good
-- assistant workspace and a poor *business execution* workspace: a project
-- cannot name the customer it is for, cannot carry the contracts that execute
-- it, has no team, no phases, no documents with a lifecycle, no approvals and
-- no calendar. A construction business running «ویلا A01» had nowhere to put
-- the contractor agreement, the drawing revision or the site-visit date.
--
-- This migration is the data half of that expansion. Two rules govern it:
--
--   1. EXTEND, NEVER REPLACE. `ai_projects` stays the project table and
--      `ai_project_tasks` stays the task table — every existing row, index,
--      RLS policy, service function, API route and screen keeps working
--      untouched. Nothing is renamed; the module is renamed in the UI and the
--      route table, not in the schema. Renaming `ai_projects` would have meant
--      rewriting eight migrations' worth of foreign keys (ai_conversations,
--      journal_entries, media_assets, message_campaigns, ai_automations,
--      ai_coworker_jobs, ai_project_notes/memory/tasks) for a cosmetic gain.
--
--   2. EVERY NEW COLUMN IS NULLABLE OR DEFAULTED. An upgrading tenant needs no
--      backfill: an existing project is simply a project with no type, no
--      dates, no tags and no customer — which is exactly what it is today.
--
-- The two CHECK constraints that are *widened* (project status, task status)
-- are widened only: every value they accepted before they still accept, so no
-- existing row can be invalidated and no existing writer can start failing.
--
-- Eleven new tables. Two shapes, chosen per table and never mixed:
--   * tenant-direct (`business_id` + the standard policy) for anything a
--     business reads across projects — contracts, documents, approvals,
--     events, templates, activity. These are the tables the workspace-wide
--     lists and the dashboard read, and giving them their own business_id is
--     what lets those reads be one indexed query instead of a join per row.
--   * parent-scoped (reach tenant scope through ai_projects) for the tables
--     that only ever exist inside one project — phases, members, task
--     checklist items, task dependencies — exactly like ai_project_notes
--     (0111), ai_project_memory (0158) and ai_project_tasks (0159).
-- Both shapes get RLS enabled, forced, and a `tenant_isolation` policy in this
-- same file, per the repo's standing rule.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The project itself — business execution fields
-- ---------------------------------------------------------------------------
--
-- `status` gains two values. `planning` is the state a project is in before
-- work starts (a tender, a quote, a brief) and `cancelled` is the state that
-- is NOT `completed` — conflating "we finished" with "we stopped" makes every
-- delivery report a lie. The three original values are kept verbatim so no row
-- and no caller changes.
ALTER TABLE ai_projects
    DROP CONSTRAINT IF EXISTS ai_projects_status_check;
ALTER TABLE ai_projects
    ADD CONSTRAINT ai_projects_status_check
        CHECK (status IN ('planning', 'active', 'paused', 'completed', 'cancelled'));

ALTER TABLE ai_projects
    -- A paragraph about the project, distinct from `instructions`, which is a
    -- directive addressed to the assistant. Mixing the two made owners write
    -- "this project is for ABC Co." into a field the model treats as an order.
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    -- The template family this project follows ('construction', 'software',
    -- …). Free text with no FK on purpose: the catalogue of built-in types
    -- lives in code (`workspace-shared.ts`) so no tenant needs seeding, and a
    -- business's own template is a row in workspace_project_templates below.
    ADD COLUMN IF NOT EXISTS project_type text,
    ADD COLUMN IF NOT EXISTS template_key text,
    -- Dates are Gregorian in the database and Shamsi on every screen — the
    -- repo's standing rule. `date`, not timestamptz: a project's start is a
    -- calendar day, and a timestamp would make it shift across time zones.
    ADD COLUMN IF NOT EXISTS start_date date,
    ADD COLUMN IF NOT EXISTS end_date date,
    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
    -- The CRM/accounting counterparty this project is FOR — the customer of
    -- «ویلا A01». `parties` is the one identity table (0137/0148), so this is a
    -- reference to it and never a copied name. ON DELETE SET NULL: removing a
    -- party must not delete the project's history.
    ADD COLUMN IF NOT EXISTS party_id uuid REFERENCES parties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_projects_party
    ON ai_projects (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_projects_business_end_date
    ON ai_projects (business_id, end_date)
    WHERE end_date IS NOT NULL AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Phases — the template engine's runtime
-- ---------------------------------------------------------------------------
--
-- A construction project has Planning → Design → Approval → Procurement →
-- Construction → Inspection → Handover; a software project has four stages and
-- a marketing project has four different ones. Hardcoding any of them would
-- make the engine a restaurant/construction engine rather than a project
-- engine, so a phase is a ROW, applied from a template at creation time and
-- editable afterwards. Parent-scoped: a phase never exists outside a project.
CREATE TABLE workspace_project_phases (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (btrim(name) <> ''),
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'done', 'skipped')),
    display_order integer NOT NULL DEFAULT 0,
    start_date    date,
    end_date      date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_phases_project
    ON workspace_project_phases (project_id, display_order);

ALTER TABLE workspace_project_phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_project_phases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_project_phases FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_projects p
                    WHERE p.id = project_id AND p.business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_projects p
                    WHERE p.id = project_id AND p.business_id = app_current_business())
    );

-- ---------------------------------------------------------------------------
-- 3. Members — the per-project role, on top of the platform's permissions
-- ---------------------------------------------------------------------------
--
-- This is NOT a second permission system. `permissions.ts` still decides who
-- may open the workspace at all and who may manage contracts or approve; this
-- table decides a member's role WITHIN one project, which the platform
-- permissions cannot express because they are business-wide by construction.
-- The effective right is the intersection: a member needs the platform
-- permission AND a sufficient project role (see `workspace-shared.ts`).
--
-- The five roles are the brief's: owner, manager, editor, contributor, viewer.
CREATE TABLE workspace_members (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid NOT NULL REFERENCES ai_projects(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('owner', 'manager', 'editor', 'contributor', 'viewer')),
    added_by    text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, user_id)
);
CREATE INDEX idx_workspace_members_user ON workspace_members (user_id);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_members FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_projects p
                    WHERE p.id = project_id AND p.business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_projects p
                    WHERE p.id = project_id AND p.business_id = app_current_business())
    );

-- ---------------------------------------------------------------------------
-- 4. Tasks — the operational layer 0159 deliberately deferred
-- ---------------------------------------------------------------------------
--
-- 0159 shipped a task with a title and two states, and said the operational
-- columns "earn their place only once a project has people and deadlines
-- hanging off it". It does now. Same widening discipline as the project
-- status: `open` and `done` keep their exact meaning, and the two new states
-- sit between them. Everything else is nullable.
ALTER TABLE ai_project_tasks
    DROP CONSTRAINT IF EXISTS ai_project_tasks_status_check;
ALTER TABLE ai_project_tasks
    ADD CONSTRAINT ai_project_tasks_status_check
        CHECK (status IN ('open', 'in_progress', 'blocked', 'done'));

ALTER TABLE ai_project_tasks
    ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    ADD COLUMN IF NOT EXISTS due_date date,
    -- The customer/supplier this task concerns, when it is not the project's
    -- own party («تماس با تأمین‌کنندهٔ سیمان» on a project owned by ABC Co.).
    ADD COLUMN IF NOT EXISTS party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS phase_id uuid REFERENCES workspace_project_phases(id) ON DELETE SET NULL,
    -- Kanban ordering within a column. Integer, sparse, rewritten on drag.
    ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

-- The dashboard's central read: "the tasks assigned to me that are not done",
-- soonest first.
CREATE INDEX IF NOT EXISTS idx_ai_project_tasks_assignee_due
    ON ai_project_tasks (assignee_user_id, due_date)
    WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS idx_ai_project_tasks_phase
    ON ai_project_tasks (phase_id) WHERE phase_id IS NOT NULL;

-- A checklist is a task's own sub-steps: too small to be tasks (they have no
-- assignee, no date, no board column), too structured to be a paragraph.
CREATE TABLE workspace_task_checklist (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       uuid NOT NULL REFERENCES ai_project_tasks(id) ON DELETE CASCADE,
    title         text NOT NULL CHECK (btrim(title) <> ''),
    done          boolean NOT NULL DEFAULT false,
    display_order integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_checklist_task
    ON workspace_task_checklist (task_id, display_order);

ALTER TABLE workspace_task_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_task_checklist FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_task_checklist FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_project_tasks t
                     JOIN ai_projects p ON p.id = t.project_id
                    WHERE t.id = task_id AND p.business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_project_tasks t
                     JOIN ai_projects p ON p.id = t.project_id
                    WHERE t.id = task_id AND p.business_id = app_current_business())
    );

-- "This task cannot start until that one is done." A row, not a column, since
-- a task may wait on several. The self-loop is refused by the CHECK; longer
-- cycles are refused in application code before the write (a recursive CHECK
-- is not expressible, and a trigger would fire on every board drag).
CREATE TABLE workspace_task_dependencies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       uuid NOT NULL REFERENCES ai_project_tasks(id) ON DELETE CASCADE,
    depends_on_id uuid NOT NULL REFERENCES ai_project_tasks(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
);
CREATE INDEX idx_workspace_task_deps_depends
    ON workspace_task_dependencies (depends_on_id);

ALTER TABLE workspace_task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_task_dependencies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_task_dependencies FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_project_tasks t
                     JOIN ai_projects p ON p.id = t.project_id
                    WHERE t.id = task_id AND p.business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM ai_project_tasks t
                     JOIN ai_projects p ON p.id = t.project_id
                    WHERE t.id = task_id AND p.business_id = app_current_business())
    );

-- ---------------------------------------------------------------------------
-- 5. Contracts — EXECUTION contracts, not relationship contracts
-- ---------------------------------------------------------------------------
--
-- The split is deliberate and is the brief's central architectural request.
-- The CRM owns the RELATIONSHIP contract: the sales agreement, the service
-- agreement, the partnership — contracts whose subject is "what we and this
-- customer agreed to", which belong on the customer's file. This table owns
-- the EXECUTION contract: the contractor, the supplier, the consultant, the
-- subcontractor, the vendor, the developer — contracts whose subject is "how
-- this project gets delivered".
--
-- They are different tables rather than one table with a flag because they are
-- read by different apps, gated by different permissions (crm.* vs
-- workspace.contracts_manage) and have different lifecycles. A single
-- "contracts" table would have forced the CRM to filter every read by a type
-- column it does not own, which is how one app ends up quietly authoritative
-- over another app's data.
--
-- Tenant-direct: «کدام قراردادها ماه آینده منقضی می‌شوند؟» is a business-wide
-- question the assistant and the dashboard both ask, and it must not require
-- walking every project.
CREATE TABLE workspace_contracts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Nullable: a framework agreement with a supplier may precede the project
    -- it will later serve. ON DELETE SET NULL for the same reason
    -- ai_conversations.project_id uses it (0111) — archiving a project must
    -- never destroy a signed contract.
    project_id    uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    -- The counterparty, on the one identity table.
    party_id      uuid REFERENCES parties(id) ON DELETE SET NULL,
    title         text NOT NULL CHECK (btrim(title) <> ''),
    contract_type text NOT NULL DEFAULT 'other'
                      CHECK (contract_type IN (
                          'contractor', 'supplier', 'consultant', 'subcontractor',
                          'vendor', 'developer', 'service', 'other')),
    -- Integer Rial, like every other money column in the product. The UI
    -- converts to the business's display unit at the boundary.
    value_rial    bigint CHECK (value_rial IS NULL OR value_rial >= 0),
    start_date    date,
    end_date      date,
    status        text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'pending_approval', 'active',
                                        'expired', 'terminated', 'completed')),
    -- Days before end_date at which the workspace surfaces the expiry. NULL =
    -- no reminder. A number rather than a scheduled row: the reminder is a
    -- READ (the dashboard and calendar compute it), so there is nothing to
    -- deliver, nothing to retry and nothing to leak on a restore.
    reminder_days integer CHECK (reminder_days IS NULL OR reminder_days BETWEEN 0 AND 365),
    notes         text NOT NULL DEFAULT '',
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_contracts_business
    ON workspace_contracts (business_id, status);
CREATE INDEX idx_workspace_contracts_project
    ON workspace_contracts (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_workspace_contracts_party
    ON workspace_contracts (party_id) WHERE party_id IS NOT NULL;
-- "Which contracts expire next month?" — the assistant's own question.
CREATE INDEX idx_workspace_contracts_expiry
    ON workspace_contracts (business_id, end_date) WHERE end_date IS NOT NULL;

ALTER TABLE workspace_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_contracts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_contracts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. Documents — one record, many owners, over the Media Library
-- ---------------------------------------------------------------------------
--
-- The bytes stay in `media_assets` (0149): this table is the *document*, which
-- is a different thing from a file. A document has a title, a version chain, a
-- review state and a set of things it belongs to; a media asset has a mime
-- type and a storage key. Pointing at the library instead of copying it means
-- the storage quota, the AI labelling, the provenance flags and the delete
-- path all keep their single implementation.
--
-- The five owners are nullable columns rather than a polymorphic pair because
-- a document genuinely belongs to several at once — «Drawing_v4.pdf» is on the
-- project AND under the construction contract — and because a typed FK is what
-- makes "every document of this contract" an indexed read.
CREATE TABLE workspace_documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    media_asset_id  uuid REFERENCES media_assets(id) ON DELETE SET NULL,
    title           text NOT NULL CHECK (btrim(title) <> ''),
    description     text NOT NULL DEFAULT '',
    project_id      uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    task_id         uuid REFERENCES ai_project_tasks(id) ON DELETE SET NULL,
    contract_id     uuid REFERENCES workspace_contracts(id) ON DELETE SET NULL,
    party_id        uuid REFERENCES parties(id) ON DELETE SET NULL,
    journal_entry_id uuid REFERENCES journal_entries(id) ON DELETE SET NULL,
    -- The review lifecycle. `draft` → `in_review` → `approved`/`rejected`.
    status          text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'archived')),
    -- Versioning as a chain, not a table: v4 is a row whose
    -- `supersedes_id` is v3. The head of a chain is the row nothing
    -- supersedes, which is one indexed predicate rather than a MAX() per
    -- document, and every older version stays readable at its own id — which
    -- is the entire point of versioning a drawing.
    version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    supersedes_id   uuid REFERENCES workspace_documents(id) ON DELETE SET NULL,
    tags            text[] NOT NULL DEFAULT '{}',
    created_by      text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_documents_business
    ON workspace_documents (business_id, created_at DESC);
CREATE INDEX idx_workspace_documents_project
    ON workspace_documents (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_workspace_documents_contract
    ON workspace_documents (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX idx_workspace_documents_task
    ON workspace_documents (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_workspace_documents_party
    ON workspace_documents (party_id) WHERE party_id IS NOT NULL;

ALTER TABLE workspace_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 7. Approvals — one request shape for every approvable subject
-- ---------------------------------------------------------------------------
--
-- Polymorphic on purpose, and it is the one place polymorphism is right here:
-- the *approval* is identical whatever is being approved (who asked, who must
-- decide, what they decided, when, why), while the subject's own table has
-- nothing to gain from an approval column. A per-subject approval table would
-- be four copies of the same five columns and four copies of the dashboard's
-- "pending approvals" query.
CREATE TABLE workspace_approvals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    subject_type  text NOT NULL
                      CHECK (subject_type IN ('project', 'task', 'document', 'contract')),
    subject_id    uuid NOT NULL,
    -- Denormalised for the dashboard's "pending approvals in my projects"
    -- read, and nullable because a business-level contract has no project.
    project_id    uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    title         text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Who must decide. NULL = anyone holding `workspace.approve`.
    approver_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    due_date      date,
    decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at    timestamptz,
    note          text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_approvals_pending
    ON workspace_approvals (business_id, status, created_at DESC);
CREATE INDEX idx_workspace_approvals_subject
    ON workspace_approvals (subject_type, subject_id);
CREATE INDEX idx_workspace_approvals_approver
    ON workspace_approvals (approver_user_id) WHERE status = 'pending';

ALTER TABLE workspace_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_approvals FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 8. Calendar events — the meetings the derived dates cannot express
-- ---------------------------------------------------------------------------
--
-- The workspace calendar is mostly DERIVED: a project's end_date, a task's
-- due_date, a contract's expiry and an approval's due_date are already dates on
-- rows that exist, and copying them into an events table would create two
-- sources of truth that drift the first time somebody reschedules a task. This
-- table therefore holds only what has nowhere else to live — a meeting, a site
-- visit, a milestone — and the calendar read unions it with the four derived
-- sources.
CREATE TABLE workspace_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id   uuid REFERENCES ai_projects(id) ON DELETE CASCADE,
    task_id      uuid REFERENCES ai_project_tasks(id) ON DELETE CASCADE,
    title        text NOT NULL CHECK (btrim(title) <> ''),
    description  text NOT NULL DEFAULT '',
    kind         text NOT NULL DEFAULT 'meeting'
                     CHECK (kind IN ('meeting', 'milestone', 'reminder', 'site_visit', 'other')),
    -- A calendar day plus an optional wall-clock time. Stored apart so an
    -- all-day event is not a midnight timestamp that moves across time zones,
    -- which is the bug that makes a Shamsi calendar show yesterday.
    event_date   date NOT NULL,
    start_time   time,
    end_time     time,
    location     text NOT NULL DEFAULT '',
    created_by   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_events_business_date
    ON workspace_events (business_id, event_date);
CREATE INDEX idx_workspace_events_project
    ON workspace_events (project_id) WHERE project_id IS NOT NULL;

ALTER TABLE workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 9. Templates — a business's own project blueprints
-- ---------------------------------------------------------------------------
--
-- The built-in families (construction, architecture, software, marketing,
-- event, consulting, generic) are a code catalogue, so every tenant has them
-- from the first request with no seed migration and an improvement to a
-- template reaches every business at once. This table is only for the
-- templates a BUSINESS defines — which is why `phases` is jsonb: a template's
-- phase list is a value edited as a whole, never queried into.
CREATE TABLE workspace_project_templates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    key           text NOT NULL CHECK (btrim(key) <> ''),
    name          text NOT NULL CHECK (btrim(name) <> ''),
    description   text NOT NULL DEFAULT '',
    project_type  text,
    phases        jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
    archived_at   timestamptz,
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, key)
);
CREATE INDEX idx_workspace_templates_business
    ON workspace_project_templates (business_id) WHERE archived_at IS NULL;

ALTER TABLE workspace_project_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_project_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_project_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 10. Comments — one thread shape for every commentable subject
-- ---------------------------------------------------------------------------
--
-- Same reasoning as approvals: a comment is the same five columns wherever it
-- hangs, and the alternative is four near-identical tables.
CREATE TABLE workspace_comments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    subject_type text NOT NULL
                     CHECK (subject_type IN ('project', 'task', 'document', 'contract')),
    subject_id   uuid NOT NULL,
    body         text NOT NULL CHECK (btrim(body) <> ''),
    author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    author_name  text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_comments_subject
    ON workspace_comments (subject_type, subject_id, created_at DESC);

ALTER TABLE workspace_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_comments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_comments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 11. Activity — the workspace's own recent-activity feed
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT the platform audit log: that one is a security record with
-- its own retention and its own reader. This is the dashboard's «فعالیت اخیر»
-- strip — a short, human, per-business list of what moved today, written by
-- the workspace services and read by nothing else.
CREATE TABLE workspace_activity (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    project_id   uuid REFERENCES ai_projects(id) ON DELETE CASCADE,
    subject_type text NOT NULL
                     CHECK (subject_type IN ('project', 'task', 'document', 'contract', 'approval', 'member', 'event')),
    subject_id   uuid,
    action       text NOT NULL,
    summary      text NOT NULL DEFAULT '',
    actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name   text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_workspace_activity_business
    ON workspace_activity (business_id, created_at DESC);
CREATE INDEX idx_workspace_activity_project
    ON workspace_activity (project_id, created_at DESC) WHERE project_id IS NOT NULL;

ALTER TABLE workspace_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_activity FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 12. Backfill: every existing project gets its creator as owner
-- ---------------------------------------------------------------------------
--
-- Without this, an upgrading tenant's existing projects would have an empty
-- team, and a member-scoped read would show them nothing — an outage dressed
-- as a feature. `owner_user_id` is the project's owner when it is set (0143);
-- otherwise `created_by`, which holds a user id as text. Only rows that
-- resolve to a real, current user of the same business are inserted, and the
-- ON CONFLICT makes the whole statement re-runnable.
INSERT INTO workspace_members (project_id, user_id, role, added_by)
SELECT p.id, u.id, 'owner', 'migration_0167'
  FROM ai_projects p
  JOIN users u
    ON u.business_id = p.business_id
   AND u.id = COALESCE(
         p.owner_user_id,
         CASE WHEN p.created_by ~ '^[0-9a-fA-F-]{36}$' THEN p.created_by::uuid END)
ON CONFLICT (project_id, user_id) DO NOTHING;
