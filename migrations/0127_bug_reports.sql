-- ============================================================================
-- 0127_bug_reports.sql — in-app bug reporting (shake / sidebar footer).
--
-- A member can file a report from anywhere in the dashboard: shake the phone
-- or tap the small bug icon at the bottom of the sidebar. The report is a
-- free-text description plus an optional screenshot of the current screen (a
-- downscaled JPEG data URL produced client-side with html2canvas-pro).
--
-- One table, tenant-scoped exactly like every other business table: RLS keyed
-- on app_current_business() (see 0021), so a report is only visible to the
-- business that filed it. The platform console reads these rows through its
-- deliberate tenant-bypass scope.
-- ============================================================================

CREATE TABLE bug_reports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    description   text NOT NULL,
    -- A "data:image/jpeg;base64,..." data URL, downscaled client-side. NULL when
    -- the reporter chose not to attach a screenshot.
    screenshot    text,
    -- The page the report was filed from, plus the browser facts that help a
    -- developer reproduce the problem without asking the reporter for them.
    page_url      text,
    user_agent    text,
    viewport      text,
    status        text NOT NULL DEFAULT 'new',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bug_reports_business_time ON bug_reports (business_id, created_at DESC);

ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE bug_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON bug_reports;
CREATE POLICY tenant_isolation ON bug_reports FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
