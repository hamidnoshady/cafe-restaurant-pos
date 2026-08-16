-- Selling an ingredient that has no cost yet must not fail at payment.
--
-- 0015 gave inventory_negative_layers a value/quantity biconditional:
--
--     ((remaining_quantity = 0) = (remaining_provisional_value_rial = 0))
--
-- One half of that is a real integrity rule: a fully settled layer must not
-- strand value behind it. The other half is not a rule at all — it asserts that
-- any layer with quantity outstanding is worth at least one Rial, and two
-- ordinary situations break it:
--
--   1. An ingredient sold before it was ever purchased. inventory_items.avg_cost
--      defaults to 0, so the shortfall is priced at zero: full quantity
--      outstanding, nothing to carry. inventory-consumption-exact.ts anticipates
--      exactly this — it sets is_unpriced from a zero fallback cost, one line
--      above the value it computes — so the writer and the constraint have
--      contradicted each other since 0015. The sale died at checkout with a
--      23514 that reached the cashier as "unexpected error, try again",
--      leaving an order that could never be closed.
--   2. Rial rounding. A small quantity at a low unit cost rounds to zero, and a
--      partially settled layer's remainder rounds to zero the same way, both
--      with quantity still outstanding.
--
-- So: keep the half that protects the ledger, drop the half that misdescribes an
-- unpriced shortfall. The settlement path already handles these layers without
-- change — proportionalDepletionValue() returns 0 out of a 0 remainder, and the
-- purchase that settles the layer books its whole actual cost as an upward
-- variance, which is the correct treatment for stock that was consumed before
-- anyone knew what it cost.
ALTER TABLE inventory_negative_layers
    DROP CONSTRAINT IF EXISTS negative_layer_exact_value_bounds;

ALTER TABLE inventory_negative_layers ADD CONSTRAINT negative_layer_exact_value_bounds CHECK (
  (original_provisional_value_rial IS NULL AND remaining_provisional_value_rial IS NULL)
  OR (
    original_provisional_value_rial IS NOT NULL AND original_provisional_value_rial >= 0
    AND remaining_provisional_value_rial IS NOT NULL AND remaining_provisional_value_rial >= 0
    AND remaining_provisional_value_rial <= original_provisional_value_rial
    -- A settled layer carries no value; an outstanding one may legitimately
    -- carry none (unpriced, or rounded away).
    AND (remaining_quantity > 0 OR remaining_provisional_value_rial = 0)
  )
);
