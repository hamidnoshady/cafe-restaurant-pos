-- Phase 21 Wave 3 -- a weighted item needs a cost basis (to post real COGS
-- on sale) and a lifecycle status (a specific physical piece stops being
-- available once sold), mirroring item_serials.status exactly -- the same
-- "one physical unit, one lifecycle" shape Wave 1 already built for
-- tracking='serial' items.
--
-- unit_cost_per_gram is nullable (not NOT NULL): a simple average-cost-per-
-- piece basis is enough for this wave (recorded at intake) -- full FIFO
-- lot-tracking across many pieces of fungible bulk gold stays deferred
-- until a business actually needs to pool raw material across pieces, the
-- same "prove the simple case first" call this phase has made before it.
-- Nullable so an item can exist (e.g. mid-intake) before its cost is known,
-- with the sale path itself refusing to sell an item with no cost basis set.
ALTER TABLE item_weight_attributes
    ADD COLUMN unit_cost_per_gram numeric(24, 9) CHECK (unit_cost_per_gram IS NULL OR unit_cost_per_gram > 0),
    ADD COLUMN status text NOT NULL DEFAULT 'in_stock'
        CHECK (status IN ('in_stock', 'reserved', 'sold'));
