-- Phase F/M4 remainder — project_id on ai_automations and ai_coworker_jobs.
--
-- The migration map (audit §5, row M4) named "entity project_id FKs on
-- agents/coworkers/automations" as part of making Projects the place a business
-- keeps long-running context. Phase F already gave a project its instruction,
-- notes, memory, tasks, conversation list, a pinned default agent, and its
-- files. The two long-running *background* entities — the scheduled/event
-- coworker jobs (0100) and the WHEN/IF/THEN automations (0155) — could not yet
-- belong to a project, so "the closing-checklist work for the Vanak launch
-- project" had nowhere to record which project it served.
--
-- These two additive columns close that gap. Both are the exact shape the media
-- library already uses for the same idea (0161): a nullable FK with
-- ON DELETE SET NULL, so archiving or deleting a project never deletes the
-- automation/job that referenced it — the rule keeps running, it simply loses
-- its project label. A partial index (non-null only) serves the new
-- "the automations/jobs in this project" read, mirroring 0111's
-- ai_conversations.project_id index.
--
-- Backfill-safe: every existing row keeps NULL (no project), which is exactly
-- its current meaning — a business-wide rule not scoped to any project.
--
-- No RLS change: both tables already carry business_id and their
-- tenant_isolation policies cover every column; a NULL-able project_id adds a
-- label, not a new tenant boundary. The project it points at is always in the
-- same business (enforced in application code before the write, the same way
-- the pinned default agent is checked in ai-projects.updateProject).

ALTER TABLE ai_automations
    ADD COLUMN project_id uuid NULL REFERENCES ai_projects(id) ON DELETE SET NULL;

ALTER TABLE ai_coworker_jobs
    ADD COLUMN project_id uuid NULL REFERENCES ai_projects(id) ON DELETE SET NULL;

CREATE INDEX idx_ai_automations_project
    ON ai_automations (project_id) WHERE project_id IS NOT NULL;

CREATE INDEX idx_ai_coworker_jobs_project
    ON ai_coworker_jobs (project_id) WHERE project_id IS NOT NULL;
