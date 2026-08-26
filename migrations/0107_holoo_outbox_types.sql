-- ============================================================================
-- 0107_holoo_outbox_types.sql — Phase 26 / issue #125 (Wave 8)
-- Open integration_outbox_events.entity_type to the Holoo push kinds.
--
-- The outbox is the push queue for both providers. WooCommerce pushes stock
-- and price; Holoo pushes whole documents — a sale, a receipt, a purchase.
-- This widens the entity_type CHECK so those document kinds can be enqueued
-- and drained by the same retry/backoff/dead-letter machinery.
-- ============================================================================

ALTER TABLE integration_outbox_events
    DROP CONSTRAINT IF EXISTS integration_outbox_events_entity_type_check;
ALTER TABLE integration_outbox_events
    ADD CONSTRAINT integration_outbox_events_entity_type_check
        CHECK (entity_type IN (
            'stock', 'price', 'catalogue_export', 'customer_export',
            'holoo_sale', 'holoo_receipt', 'holoo_purchase'
        ));
