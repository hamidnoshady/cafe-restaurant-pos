-- ============================================================================
-- 0108_holoo_runtime_completion.sql — Phase 26 / issue #125 runtime closure
--
-- Completes the runtime rails that sit on top of the original Holoo schema:
-- direct-SQL arming records the profile that was pinned at the moment the
-- operator typed the confirmation phrase, and companion activation is an
-- audited timestamp on holoo_connection_settings (already present in 0103).
-- ============================================================================

ALTER TABLE holoo_connection_settings
    ADD COLUMN direct_sql_profile_key text;

CREATE INDEX idx_holoo_connection_settings_companion_active
    ON holoo_connection_settings (business_id, companion_activated_at)
    WHERE companion_activated_at IS NOT NULL;
