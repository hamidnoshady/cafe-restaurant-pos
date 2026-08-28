-- ============================================================================
-- 0109_holoo_legacy_woocommerce_credentials.sql — Phase 26 follow-up
--
-- 0103 opened `integration_connections.provider` to a second value ('holoo')
-- and, to let a Holoo connection leave the four WooCommerce-only columns
-- NULL, dropped their NOT NULLs and re-imposed them through a single
-- provider-conditional CHECK, `integration_connections_provider_credentials`.
--
-- As written in 0103 that CHECK reads:
--
--     provider <> 'woocommerce'
--     OR (base_url IS NOT NULL
--         AND consumer_key_ciphertext IS NOT NULL
--         AND consumer_secret_ciphertext IS NOT NULL
--         AND webhook_secret_ciphertext IS NOT NULL)
--
-- which demands consumer keys from *every* WooCommerce connection. That is
-- wrong for the plugin link mode 0076 introduced, and it is wrong in two
-- different ways:
--
--  1. It contradicts 0076, whose whole point was that "REST consumer keys are
--     meaningless in plugin mode, so they stop being mandatory — but only
--     there." 0076 dropped the NOT NULLs on both consumer-key columns and
--     recorded the rest_api-only requirement in
--     `integration_connections_mode_credentials`. 0103's CHECK re-imposes it
--     for plugin rows too, so 0076's rule is silently reversed.
--  2. It rejects rows the application legitimately writes. `createConnection()`
--     in src/lib/integrations/connections-service.ts inserts
--     `linkMode === "rest_api" ? encryptSecret(...) : null` for both consumer
--     key columns, so every plugin-mode connection has them NULL by design.
--     After 0103, creating one fails the CHECK — and because ADD CONSTRAINT
--     validates the rows already in the table, a database that already holds a
--     plugin connection cannot apply 0103 at all.
--
-- So: re-impose the guarantee for the connections that actually have it, and
-- leave plugin connections alone. This restores, for provider = 'woocommerce',
-- exactly the column-level state that existed immediately before 0103:
--
--   - base_url and webhook_secret_ciphertext were NOT NULL from 0070 for every
--     WooCommerce row, plugin mode included, and stay required here;
--   - consumer_key_ciphertext / consumer_secret_ciphertext were NOT NULL from
--     0070 but became rest_api-only in 0076 — and stay rest_api-only, because
--     `integration_connections_mode_credentials` (kept untouched by 0103 and
--     still in force) already enforces precisely that:
--
--         provider = 'holoo'
--         OR link_mode = 'plugin'
--         OR (consumer_key_ciphertext IS NOT NULL
--             AND consumer_secret_ciphertext IS NOT NULL)
--
--     Repeating them here would add nothing for a rest_api connection and
--     would break a plugin one, so this constraint deliberately omits them.
--
-- A Holoo connection is unaffected: it still skips both checks via
-- `provider <> 'woocommerce'` and `provider = 'holoo'`, and its own
-- credentials live on holoo_connection_settings.
--
-- This is a strict relaxation of 0103's predicate — every disjunct of the old
-- CHECK still satisfies the new one — so any database that applied 0103 has no
-- row this can fail against, and the ADD CONSTRAINT validation is a no-op.
--
-- 0103 is *not* edited, even though the defect is in it: it is an applied
-- migration, and scripts/migrate.ts throws `migration_checksum_mismatch` if a
-- recorded file's contents change (CLAUDE.md: "never edit an already-applied
-- migration"). The correction belongs in a forward-only file of its own.
-- ============================================================================

ALTER TABLE integration_connections
    DROP CONSTRAINT IF EXISTS integration_connections_provider_credentials;

ALTER TABLE integration_connections
    ADD CONSTRAINT integration_connections_provider_credentials CHECK (
        provider <> 'woocommerce'
        OR link_mode = 'plugin'
        OR (
            base_url IS NOT NULL
            AND webhook_secret_ciphertext IS NOT NULL
        )
    );
