-- ============================================================================
-- 0166_retire_workspace_flag.sql — retire the `workspace` feature flag
--
-- The app-ecosystem shell (chat home at /dashboard, the workspace rail, the
-- app launchers) is no longer an opt-in gated by a flag: it is the product's
-- one shell for every business. The runtime flag reads are gone from the code
-- (nothing checks `features.workspace` any more), so the catalogue row and
-- any per-business overrides are dead data. This migration removes them.
--
-- Constraint safety: `business_features.flag_key` and the billing-plan tables
-- reference `feature_flags(key)` with ON DELETE CASCADE (0020_*, 0130_*), so
-- deleting the catalogue row below is legal in one statement — but the
-- overrides are deleted explicitly first so the intent is auditable and the
-- plan-entitlement rows for `workspace` go away deliberately rather than as a
-- side effect of a cascade a future reader might not expect. `ai_assistant`
-- and every other flag are untouched: the assistant stays an entitlement,
-- governed by its own flag as before.
-- ============================================================================

DELETE FROM business_features
WHERE flag_key = 'workspace';

DELETE FROM billing_plan_features
WHERE feature_key = 'workspace';

DELETE FROM feature_flags
WHERE key = 'workspace';
