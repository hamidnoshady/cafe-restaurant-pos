-- ============================================================================
-- 0105_holoo_import_runs.sql — Phase 26 / issue #125 (Wave 6)
-- Import-run tracking for the migration wizard.
--
-- Rollback needs to answer "which rows did *this* run create?" and revert only
-- those, so every Holoo mapping row can point at the run that made it. This
-- adds a tenant-scoped `holoo_import_runs` ledger and an `import_run_id` column
-- on integration_mappings (nullable — WooCommerce mappings predate it and keep
-- NULL). Waves 3–5 write mappings; a run row is opened before an apply and the
-- run id is stamped onto each mapping it writes.
--
-- No core table grows a column; the new table takes the standard RLS policy.
-- ============================================================================

CREATE TABLE holoo_import_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id uuid NOT NULL,
    status        text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'rolled_back')),
    summary       jsonb,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, business_id),
    CONSTRAINT holoo_import_runs_connection_business_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES integration_connections (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_holoo_import_runs_connection
    ON holoo_import_runs (connection_id, created_at DESC);

ALTER TABLE integration_mappings
    ADD COLUMN import_run_id uuid REFERENCES holoo_import_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_integration_mappings_import_run
    ON integration_mappings (import_run_id) WHERE import_run_id IS NOT NULL;

ALTER TABLE holoo_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE holoo_import_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holoo_import_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
