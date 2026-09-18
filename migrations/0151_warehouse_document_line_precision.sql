-- ============================================================================
-- 0151_warehouse_document_line_precision.sql — Phase 42 follow-up
--
-- `warehouse_document_lines.quantity` shipped in 0141 as numeric(14,3), which
-- is the pre-0015 quantity precision. Every other quantity column on the F&B
-- costing path was widened to numeric(24,9) by 0015_exact_inventory_cost_basis
-- (stock_movements.quantity, inventory_lots.remaining_qty/original_quantity,
-- purchase_items.quantity, stock_count_lines.*), and the service layer speaks
-- `QuantityText` — canonical decimals of scale ≤ 9 (src/lib/inventory-exact.ts).
--
-- Two concrete defects followed from the narrower column:
--
--   1. A document silently disagreed with the stock ledger it wrote. A receipt
--      of 0.0005 kg stored `0.001` on its own line while stock_movements stored
--      the exact `0.000500000` — the document a person reads back was not the
--      quantity the inventory moved.
--
--   2. A quantity below half a milli-unit rounded to `0.000` on the way in and
--      tripped `warehouse_document_lines_quantity_check` (quantity > 0), so the
--      whole posting aborted with a Postgres CHECK violation surfacing as a 500
--      — after the caller had already passed validation.
--
-- Widening is lossless (every stored value keeps its scale) and needs no RLS
-- change: the table's policy is unchanged and still scopes through the parent
-- document. The retail twin (0142) already used numeric(24,9); this brings the
-- F&B table to the same precision.
-- ============================================================================

ALTER TABLE warehouse_document_lines
    ALTER COLUMN quantity TYPE numeric(24, 9);
