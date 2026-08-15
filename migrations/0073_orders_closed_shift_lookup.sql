-- ============================================================================
-- 0073_orders_closed_shift_lookup.sql — index for "orders closed this shift"
--
-- The orders screen now lists, next to the open queue, the orders closed
-- since the branch's running shift began (GET /api/orders?scope=shift ->
-- listOrdersClosedSince). That read is
--
--   WHERE location_id = ? AND status IN ('completed','voided')
--     AND closed_at IS NOT NULL AND closed_at >= ?  ORDER BY closed_at DESC
--
-- which 0009's idx_orders_location_closed cannot serve: that index is partial
-- on status = 'completed' alone, so including voided orders — the ones someone
-- reviewing a shift most wants to find — would drop the plan to a scan of the
-- branch's whole order history as the table grows.
--
-- Same shape, widened by one status and ordered the way the list reads it.
-- 0009's index is left alone: the reporting rollups still match its narrower
-- predicate exactly.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_orders_location_closed_any
    ON orders (location_id, closed_at DESC)
    WHERE closed_at IS NOT NULL AND status IN ('completed', 'voided');
