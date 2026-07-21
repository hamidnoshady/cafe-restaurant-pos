-- ============================================================================
-- 0003_menu_cashier_order_flow.sql — Phase 2 (Menu & Cashier Order Flow)
--
--   * Per-location order numbering: a small counter table gives an atomic,
--     race-safe "next order number" (UPDATE ... RETURNING) without relying
--     on MAX(order_number)+1 under concurrent cashiers.
--   * Orders remember how a discount was entered (percent vs fixed amount)
--     for display/audit; `orders.discount` stays the computed Rial amount
--     actually applied (already existed, used by totals).
--   * order_items gets a void_reason, mirroring orders.voided_reason, so a
--     voided line (order_item_status already has 'voided') carries why.
-- ============================================================================

CREATE TABLE order_number_counters (
    location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
    next_number bigint NOT NULL DEFAULT 1
);

ALTER TABLE orders
    ADD COLUMN discount_type  text CHECK (discount_type IN ('percent', 'amount')),
    ADD COLUMN discount_value numeric(14, 2);

ALTER TABLE order_items
    ADD COLUMN void_reason text;
