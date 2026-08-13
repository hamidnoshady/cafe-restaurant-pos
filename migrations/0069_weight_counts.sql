-- Phase 21 Wave 7 -- weight reconciliation: the weight-based analogue of
-- Phase 6's stock counts (شمارش موجودی), for a jewelry business whose
-- stock is measured on a scale rather than counted in units.
--
-- One row per (branch, day, purity) reconciliation: what the scale said
-- versus what the system believed, and the difference. `system_weight` is
-- stored rather than recomputed on read, because the whole point of a count
-- is what the books said *at the moment it was taken* -- a figure that
-- silently changed as later sales posted would make the record worthless as
-- evidence.
--
-- Deliberately posts nothing to the ledger, unlike Phase 6's stock counts
-- (which post a variance to inventoryCountExpense/inventoryCountGain). A
-- gold variance in grams has no unambiguous Rial value under this phase's
-- costing model: each piece carries its own unit_cost_per_gram, so "0.4g
-- missing" doesn't say which piece's cost basis to relieve. Valuing and
-- posting that variance needs the weight-based lot costing Wave 2
-- deferred; until then the count is an audit record, and correcting the
-- books is a manual journal (Phase 16's workflow) with this row as its
-- evidence.
CREATE TABLE weight_counts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    count_date     date NOT NULL DEFAULT CURRENT_DATE,
    purity         text NOT NULL,
    counted_weight numeric(24, 9) NOT NULL CHECK (counted_weight >= 0),
    system_weight  numeric(24, 9) NOT NULL CHECK (system_weight >= 0),
    notes          text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_weight_counts_location_date ON weight_counts (location_id, count_date DESC);

ALTER TABLE weight_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weight_counts FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));
