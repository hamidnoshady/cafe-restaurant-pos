-- ============================================================================
-- 0005_waiter_kitchen_realtime.sql — Phase 4 (Waiter + Kitchen Apps, Real-Time Sync)
--
--   * No new tables/columns: order_items already carries the full kitchen
--     status machine (pending -> sent -> preparing -> ready -> served,
--     sent_to_kitchen_at, ready_at) from migration 0001, and floor_sections
--     already carries assigned_waiter_id from migration 0004. This phase is
--     an application-layer feature (WebSocket sync, waiter/KDS UIs) on top
--     of that existing schema.
--   * One index: the KDS ticket queue orders by sent_to_kitchen_at, which had
--     no supporting index (the existing idx_order_items_location_status
--     indexes location_id + status, not the ordering column).
-- ============================================================================

CREATE INDEX idx_order_items_sent_to_kitchen ON order_items (location_id, sent_to_kitchen_at)
    WHERE status IN ('sent', 'preparing', 'ready');
