-- ============================================================================
-- 0169_data_transfer_engine.sql — «ورود و خروج داده»: the platform-wide data
-- import/export engine.
--
-- ## Why this exists
--
-- Before this migration the product had three unrelated answers to "get my
-- data in and out":
--
--   * `crm-import-service.ts` / `crm-export-service.ts` — a customer CSV
--     importer with its own aliases, its own duplicate rules and no history.
--   * `menu-import.ts` + `menu-import-apply.ts` — a menu CSV/XLSX importer
--     with a *second* set of aliases and a second parser.
--   * `report-export.ts` / `tenant-export.ts` — two more CSV writers and two
--     more XLSX writers.
--
-- None of them shared a mapping step, a preview, a template, a queue or an
-- audit trail, and every new module would have grown a fourth copy. This
-- migration is the data half of the single engine that replaces them: every
-- app registers its entities into one registry (`src/lib/data-transfer/
-- registry.ts`) and both directions run through these six tables.
--
-- ## The six tables
--
--   1. `data_import_jobs`     — one uploaded file, its mapping and its counts.
--   2. `data_import_rows`     — one parsed row, its validation verdict and the
--                               record it became. This is what makes "download
--                               the failed rows and retry" possible.
--   3. `data_export_jobs`     — one produced file, its filters and its bytes,
--                               so a previous export can be downloaded again.
--   4. `data_mapping_templates` — a saved external-column → platform-field map.
--   5. `data_export_templates`  — a saved field selection + filter set.
--   6. `data_scheduled_exports` — daily/weekly/monthly exports with email
--                               delivery, drained by a background tick.
--
-- ## Shapes and rules
--
--   * Every table is **business-scoped** and carries `business_id` except
--     `data_import_rows`, which reaches tenant scope through its parent job —
--     the same parent-EXISTS shape `workspace_project_phases` uses (0167).
--     RLS is enabled, FORCED, and given a `tenant_isolation` policy in this
--     same file, per the repo's standing rule.
--   * `entity_key` is free text with a CHECK on its shape (`app.entity`) and
--     deliberately no FK: the catalogue of entities lives in code, so that a
--     module registering a new entity needs no migration. A job whose entity
--     was retired stays readable as history.
--   * Money stays integer Rial and dates stay Gregorian `date`/`timestamptz`;
--     Shamsi is applied at the display/serialisation edge exactly as
--     everywhere else.
--   * Export bytes live in a `bytea` column rather than the object store: an
--     export is small, short-lived and must be downloadable on a deployment
--     with no S3 configured (the desktop install is exactly that). The
--     `MAX_EXPORT_BYTES` ceiling is enforced in the service, and
--     `data_export_jobs.content` is NULL once a job is pruned.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Import jobs
-- ---------------------------------------------------------------------------
CREATE TABLE data_import_jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch the import writes into, for a location-scoped entity
    -- (menu items, inventory items). NULL for a business-scoped one.
    location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
    entity_key       text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
    -- pending  → uploaded and parsed, waiting for a mapping
    -- ready    → mapped and validated, waiting for the operator to confirm
    -- queued   → confirmed; the background worker will perform it
    -- running  → the worker holds it
    -- completed/failed/cancelled → terminal
    status           text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'queued', 'running', 'completed', 'failed', 'cancelled')),
    file_name        text NOT NULL DEFAULT '',
    file_format      text NOT NULL DEFAULT 'csv'
        CHECK (file_format IN ('csv', 'xlsx', 'json', 'pdf')),
    file_size_bytes  bigint NOT NULL DEFAULT 0,
    -- The header row as it arrived, so the mapping screen can be reopened
    -- without the file, and the audit trail can say what the columns were.
    source_columns   jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- external column index/name → platform field key, plus per-field
    -- transformation rules. The same shape a mapping template stores.
    mapping          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- duplicate strategy, relationship strategy, money unit, "import valid
    -- rows only", and the rest of the operator's choices.
    options          jsonb NOT NULL DEFAULT '{}'::jsonb,
    total_rows       integer NOT NULL DEFAULT 0,
    valid_rows       integer NOT NULL DEFAULT 0,
    warning_rows     integer NOT NULL DEFAULT 0,
    error_rows       integer NOT NULL DEFAULT 0,
    created_rows     integer NOT NULL DEFAULT 0,
    updated_rows     integer NOT NULL DEFAULT 0,
    skipped_rows     integer NOT NULL DEFAULT 0,
    failed_rows      integer NOT NULL DEFAULT 0,
    -- Set when the whole job failed (a parse error, a worker crash), as
    -- opposed to individual rows failing, which live in data_import_rows.
    error            text,
    -- How many times the worker has picked this job up. A job that keeps
    -- dying is parked rather than retried forever.
    attempts         integer NOT NULL DEFAULT 0,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name  text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    finished_at      timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_data_import_jobs_business_time
    ON data_import_jobs (business_id, created_at DESC);
CREATE INDEX idx_data_import_jobs_business_entity
    ON data_import_jobs (business_id, entity_key, created_at DESC);
-- The worker's claim query: the oldest queued job, anywhere.
CREATE INDEX idx_data_import_jobs_queue
    ON data_import_jobs (status, created_at)
    WHERE status IN ('queued', 'running');

ALTER TABLE data_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_import_jobs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. Import rows — the per-row verdict
-- ---------------------------------------------------------------------------
--
-- Parent-scoped, like ai_project_notes and workspace_project_phases: a row
-- only ever exists inside one job, so reaching tenant scope through the job is
-- both correct and one less column to keep in step.
CREATE TABLE data_import_rows (
    id           bigserial PRIMARY KEY,
    job_id       uuid NOT NULL REFERENCES data_import_jobs(id) ON DELETE CASCADE,
    -- 1-based and counted the way a spreadsheet counts, header included, so a
    -- reported row number is the one the operator can scroll to.
    row_number   integer NOT NULL,
    status       text NOT NULL DEFAULT 'valid'
        CHECK (status IN ('valid', 'warning', 'error', 'created', 'updated', 'skipped', 'failed')),
    -- The raw cells as they arrived, keyed by source column. Kept so the
    -- failed-row report is the operator's own data, not our re-rendering.
    raw          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- The mapped + coerced record, keyed by platform field.
    mapped       jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- [{ field, severity, message }] — Persian, ready to display.
    messages     jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The row this became (create) or matched (update/skip).
    target_id    text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_data_import_rows_job_row
    ON data_import_rows (job_id, row_number);
CREATE INDEX idx_data_import_rows_job_status
    ON data_import_rows (job_id, status);

ALTER TABLE data_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_import_rows FOR ALL
    USING (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM data_import_jobs j
                    WHERE j.id = job_id AND j.business_id = app_current_business())
    )
    WITH CHECK (
        app_rls_bypass()
        OR EXISTS (SELECT 1 FROM data_import_jobs j
                    WHERE j.id = job_id AND j.business_id = app_current_business())
    );

-- ---------------------------------------------------------------------------
-- 3. Export jobs — and the bytes they produced
-- ---------------------------------------------------------------------------
CREATE TABLE data_export_jobs (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id      uuid REFERENCES locations(id) ON DELETE SET NULL,
    entity_key       text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
    format           text NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf', 'json')),
    status           text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    -- What the operator chose: which fields, which filters, which selection.
    fields           jsonb NOT NULL DEFAULT '[]'::jsonb,
    filters          jsonb NOT NULL DEFAULT '{}'::jsonb,
    row_count        integer NOT NULL DEFAULT 0,
    file_name        text NOT NULL DEFAULT '',
    content_type     text NOT NULL DEFAULT '',
    size_bytes       bigint NOT NULL DEFAULT 0,
    -- The produced file. NULL once pruned; the history row survives it.
    content          bytea,
    error            text,
    attempts         integer NOT NULL DEFAULT 0,
    -- Set when this export was produced by a schedule rather than a person.
    schedule_id      uuid,
    created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name  text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    started_at       timestamptz,
    finished_at      timestamptz,
    expires_at       timestamptz
);

CREATE INDEX idx_data_export_jobs_business_time
    ON data_export_jobs (business_id, created_at DESC);
CREATE INDEX idx_data_export_jobs_business_entity
    ON data_export_jobs (business_id, entity_key, created_at DESC);
CREATE INDEX idx_data_export_jobs_queue
    ON data_export_jobs (status, created_at)
    WHERE status IN ('queued', 'running');

ALTER TABLE data_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_export_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_export_jobs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. Mapping templates
-- ---------------------------------------------------------------------------
--
-- "The supplier sends the same spreadsheet every month" is the entire reason
-- this table exists: the mapping the operator built once is reusable, and a
-- mapping is per-entity because a column called «کد» means a SKU on a product
-- file and an accounting code on a person file.
CREATE TABLE data_mapping_templates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entity_key   text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    mapping      jsonb NOT NULL DEFAULT '{}'::jsonb,
    options      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- «قالب تأمین‌کننده » and «قالب تأمین‌کننده» are the same template.
CREATE UNIQUE INDEX idx_data_mapping_templates_name
    ON data_mapping_templates (business_id, entity_key, lower(btrim(name)));

ALTER TABLE data_mapping_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_mapping_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_mapping_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 5. Export templates
-- ---------------------------------------------------------------------------
CREATE TABLE data_export_templates (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    entity_key   text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
    name         text NOT NULL,
    description  text NOT NULL DEFAULT '',
    format       text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv', 'xlsx', 'pdf', 'json')),
    fields       jsonb NOT NULL DEFAULT '[]'::jsonb,
    filters      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_data_export_templates_name
    ON data_export_templates (business_id, entity_key, lower(btrim(name)));

ALTER TABLE data_export_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_export_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_export_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 6. Scheduled exports
-- ---------------------------------------------------------------------------
--
-- «فروش روزانه», «مشتریان هفتگی», «حسابداری ماهانه». The tick claims a due
-- schedule by moving `next_run_at` forward before it produces anything, so two
-- app instances ticking at once produce one export rather than two — the same
-- claim-then-perform shape as the notification fan-out.
--
-- `hour_local` is the hour of the *business's* day (Asia/Tehran by default,
-- `locations.timezone` where set), because "every morning at 7" is a statement
-- about the shop's morning, not about UTC.
CREATE TABLE data_scheduled_exports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id    uuid REFERENCES locations(id) ON DELETE SET NULL,
    entity_key     text NOT NULL CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$'),
    name           text NOT NULL,
    format         text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv', 'xlsx', 'pdf', 'json')),
    frequency      text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
    -- 0–23, in the business's own timezone.
    hour_local     integer NOT NULL DEFAULT 7 CHECK (hour_local BETWEEN 0 AND 23),
    -- 0 = شنبه … 6 = جمعه (the Persian week), for `weekly`.
    weekday        integer CHECK (weekday BETWEEN 0 AND 6),
    -- 1–31, clamped to the month's length by the scheduler, for `monthly`.
    day_of_month   integer CHECK (day_of_month BETWEEN 1 AND 31),
    fields         jsonb NOT NULL DEFAULT '[]'::jsonb,
    filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Where it goes. Both may be on: the file is stored in `data_export_jobs`
    -- (so it is downloadable from the history) and emailed as an attachment.
    deliver_email  text NOT NULL DEFAULT '',
    deliver_store  boolean NOT NULL DEFAULT true,
    is_active      boolean NOT NULL DEFAULT true,
    next_run_at    timestamptz NOT NULL DEFAULT now(),
    last_run_at    timestamptz,
    last_status    text CHECK (last_status IN ('completed', 'failed')),
    last_error     text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_data_scheduled_exports_name
    ON data_scheduled_exports (business_id, lower(btrim(name)));
-- The tick's due query.
CREATE INDEX idx_data_scheduled_exports_due
    ON data_scheduled_exports (next_run_at)
    WHERE is_active;

ALTER TABLE data_scheduled_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_scheduled_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_scheduled_exports FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- The FK is added after the table exists, so the two tables can reference each
-- other without an ordering problem. ON DELETE SET NULL: deleting a schedule
-- must never delete the exports it produced — they are history.
ALTER TABLE data_export_jobs
    ADD CONSTRAINT data_export_jobs_schedule_fk
        FOREIGN KEY (schedule_id) REFERENCES data_scheduled_exports(id) ON DELETE SET NULL;
