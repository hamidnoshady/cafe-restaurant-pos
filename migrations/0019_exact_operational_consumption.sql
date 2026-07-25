-- Exact (decimal) costing for the remaining operational consumption paths.
--
-- Waste logging and stock-count variances were still running through the
-- legacy JavaScript-Number costing path (inventory-service.consumeInventory /
-- applyStockAdjustment). Two consequences, both live:
--
--   1. Quantities and unit costs round-tripped through IEEE-754 doubles, so
--      fractional quantities and large Rial values drifted.
--   2. Far worse: that path inserts inventory_negative_layers WITHOUT
--      original/remaining_provisional_value_rial. Those columns are only
--      enforced for costing_version=2 events, and both routes created v1
--      events, so the unpriced rows were written silently. The next purchase
--      receipt touching that item then hit
--      `inventory_exact_cutover_required: negative_layer:<id>` in
--      applyPurchaseReceiptCosting and failed — permanently blocking receipts
--      for the affected item.
--
-- Both routes now emit costing_version=2 events and use the exact path, so
-- every negative layer is priced at creation.
--
-- A positive stock-count variance can now also settle open negative layers
-- (the count is authoritative evidence that the shortage was resolved on the
-- floor, not by a future purchase). The settlement audit table was keyed to
-- purchase_items only; it is generalised here to carry either source, keeping
-- the existing purchase rows and their uniqueness guarantee intact.

ALTER TABLE inventory_negative_layer_settlements
  ALTER COLUMN purchase_item_id DROP NOT NULL,
  ADD COLUMN stock_count_id uuid REFERENCES stock_counts(id) ON DELETE RESTRICT;

-- Exactly one source per settlement row.
ALTER TABLE inventory_negative_layer_settlements
  ADD CONSTRAINT chk_negative_settlement_source
  CHECK (num_nonnulls(purchase_item_id, stock_count_id) = 1);

-- Mirrors the existing UNIQUE (purchase_item_id, negative_layer_id): a given
-- count settles a given layer at most once, so a retried count transaction
-- cannot double-release the same provisional value.
CREATE UNIQUE INDEX uq_negative_settlement_stock_count
  ON inventory_negative_layer_settlements (stock_count_id, negative_layer_id)
  WHERE stock_count_id IS NOT NULL;
