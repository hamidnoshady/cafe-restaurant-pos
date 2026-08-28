-- ============================================================================
-- 0110_workspace_flag.sql — Phase 35 / issue #358 (Wave 2)
-- The `workspace` feature flag: gated rollout of the app-ecosystem shell
-- (chat home, app rail, Growth & Marketing grouping). Off by default so a
-- business that never turns it on sees the unchanged flat sidebar and the
-- legacy dashboard at /dashboard.
--
-- `isFeatureEnabled` resolves an unknown flag to TRUE (fail-open, so a typo in
-- a prefix map never silently disables a business's entitlement), which means a
-- flag that should be OFF must exist in `feature_flags` with default_enabled =
-- false. Without this row, `features.workspace` would read as enabled for every
-- business and the new shell would switch on unannounced.
-- ============================================================================

INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES (
    'workspace',
    'میز کار برنامه‌ها',
    'خانهٔ گفت‌وگو، ریل برنامه‌ها و گروه‌بندی «رشد و بازاریابی» در سایدبار',
    false
)
ON CONFLICT (key) DO NOTHING;
