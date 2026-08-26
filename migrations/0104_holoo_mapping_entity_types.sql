-- ============================================================================
-- 0104_holoo_mapping_entity_types.sql — Phase 26 / issue #125 (Wave 3)
-- Open integration_mappings.entity_type to the Holoo entity kinds.
--
-- The mapping table is the idempotency backbone and the ownership lookup for
-- the whole phase. Waves 3–5 write a mapping row per imported entity, Wave 6's
-- rollback keys off them, and Wave 7's `holooOwnedIds` reads them. They need
-- entity types that name the Holoo domain (goods, customer, account, …) rather
-- than the WooCommerce vocabulary the CHECK previously allowed.
--
-- The existing WooCommerce values ('product', 'customer', 'order', 'refund')
-- are untouched; this only widens the set.
-- ============================================================================

ALTER TABLE integration_mappings
    DROP CONSTRAINT IF EXISTS integration_mappings_entity_type_check;
ALTER TABLE integration_mappings
    ADD CONSTRAINT integration_mappings_entity_type_check
        CHECK (entity_type IN (
            -- WooCommerce (Phase 23), unchanged.
            'product', 'customer', 'order', 'refund',
            -- Holoo base data (Wave 3).
            'holoo_goods', 'holoo_customer', 'holoo_account',
            -- Holoo transactions (Wave 4).
            'holoo_invoice', 'holoo_purchase', 'holoo_receipt', 'holoo_stock',
            -- Holoo accounting (Wave 5).
            'holoo_journal',
            -- Holoo push mapping — the returned document number (Wave 8).
            'holoo_document'
        ));
