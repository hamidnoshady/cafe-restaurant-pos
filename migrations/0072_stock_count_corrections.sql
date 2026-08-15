-- Stock-count corrections (edit/remove after posting).
--
-- A posted physical count is a source document with ledger and exact-costing
-- effects, so it is never mutated in place. Correcting it (changing a line's
-- counted quantity, removing a line, or deleting the whole count) is modelled
-- as a reversal event that undoes the original variance at the original
-- recorded value, optionally followed by a fresh re-count (see
-- src/lib/stock-count-service.ts). This matches the write-down/transfer
-- convention: source lines are immutable, corrections are explicit reversals.

ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'stock_count_reversal';

-- A reversal row points back at the count it undoes; the recent-counts list
-- reads only rows where this is NULL so corrections disappear from the active
-- list while the reversal remains on the ledger and event trail.
ALTER TABLE stock_counts
  ADD COLUMN reversal_of uuid REFERENCES stock_counts(id) ON DELETE SET NULL;
CREATE INDEX idx_stock_counts_reversal ON stock_counts (reversal_of)
  WHERE reversal_of IS NOT NULL;

-- Source lines are immutable: a correction must go through the reversal path,
-- never an in-place UPDATE/DELETE on stock_count_lines.
CREATE FUNCTION reject_stock_count_line_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock count lines are immutable; create a reversal';
END $$;
CREATE TRIGGER trg_stock_count_lines_immutable
  BEFORE UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION reject_stock_count_line_mutation();
