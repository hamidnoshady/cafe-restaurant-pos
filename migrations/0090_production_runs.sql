-- ============================================================================
-- 0090_production_runs.sql — Phase 29 (in-house production)
--
-- Until now the F&B recipe model was exactly one level deep:
-- menu_items → menu_item_ingredients → inventory_items, and an inventory item
-- could only ever *enter* stock by being bought, found on a count, transferred
-- in, or returned. Nothing could say "we combined flour, eggs and sugar and now
-- we have a cake".
--
-- That is wrong for anything a café makes itself. A whole cake is built from
-- raw materials once, yields 8 slices, and each slice is then sold through its
-- own serving recipe (one slice + chocolate sauce). With one recipe level the
-- owner had to either push the whole cake's materials into the per-slice recipe
-- (baking happens once, selling happens eight times, and a cake baked but
-- unsold shows no stock at all) or not cost the cake at all.
--
-- This adds the missing middle step, for the minority of items that need it:
--
--   * inventory_items.is_produced — the produced good is an ORDINARY inventory
--     item, with its own base unit ('برش') and its own avg_cost. That is the
--     load-bearing decision: serving recipes, FIFO/weighted-average costing,
--     stock counts, waste, low-stock alerts, transfers, valuation, suggested
--     pricing and cost-drift are all already per inventory item, so none of
--     them change. The flag is descriptive, not restrictive — a café may also
--     buy ready-made cakes, so nothing here forbids purchasing a produced item.
--   * production_formulas / production_formula_inputs — "one batch of this
--     formula consumes these inputs and yields this much of that output item".
--     Deliberately the same shape as menu_item_ingredients (0001).
--   * production_runs / production_run_inputs — one actual batch: what it
--     consumed, at what exact cost, and what the output was receipted at.
--     Header + lines + per-phase event id copied from inventory_transfers
--     (0017), including reversal_of, so a run is corrected by a reversing
--     document rather than by mutating a posted one.
--
-- A formula's input may itself be a produced item (sponge base → cake →
-- slice); the only guard needed is a cycle check, which lives in
-- src/lib/production.ts.
--
-- Costing follows the existing exact (costing_version 2) path in both
-- directions: inputs go out through consumeInventoryExact (so a short raw
-- material opens a *priced* negative layer like any other consumption), and the
-- output comes in through applyProductionOutputCosting, which is the positive
-- branch of applyStockAdjustmentExact with the value given rather than derived
-- — the same posture applyPurchaseReceiptCosting takes with an invoice.
--
-- Accounting: 1310 is a WIP wash account that is zero after every run, and
-- 5180 is a contra-expense that absorbs labour/overhead into inventory value.
-- The wage itself is already booked to 5200/5400, so 5180 offsets it rather
-- than double-counting it. Net effect of a run on the books: inventory rises by
-- the conversion cost, and nothing else moves.
-- ============================================================================

ALTER TYPE stock_movement_type  ADD VALUE IF NOT EXISTS 'production_consume';
ALTER TYPE stock_movement_type  ADD VALUE IF NOT EXISTS 'production_output';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'production';
ALTER TYPE inventory_event_type ADD VALUE IF NOT EXISTS 'production_reversal';

-- Made in-house rather than bought. Drives the UI's pickers and the production
-- report; deliberately does not constrain anything.
ALTER TABLE inventory_items ADD COLUMN is_produced boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Formulas
-- ---------------------------------------------------------------------------

CREATE TABLE production_formulas (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id              uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name                     text NOT NULL,
    output_inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    -- Expected yield of ONE batch, in the output item's own base unit.
    output_quantity          numeric(24, 9) NOT NULL CHECK (output_quantity > 0),
    -- Default labour/overhead for one batch, in Rial. A run may override it.
    conversion_cost_rial     bigint NOT NULL DEFAULT 0 CHECK (conversion_cost_rial >= 0),
    notes                    text,
    is_active                boolean NOT NULL DEFAULT true,
    created_by               uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);
CREATE INDEX idx_production_formulas_location ON production_formulas (location_id);
CREATE INDEX idx_production_formulas_output ON production_formulas (output_inventory_item_id);

-- Per one batch of the formula, in each input item's own base unit — exactly
-- the contract menu_item_ingredients.quantity has.
CREATE TABLE production_formula_inputs (
    formula_id        uuid NOT NULL REFERENCES production_formulas(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity          numeric(24, 9) NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (formula_id, inventory_item_id)
);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

CREATE TABLE production_runs (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id              uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    location_id              uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    formula_id               uuid NOT NULL REFERENCES production_formulas(id) ON DELETE RESTRICT,
    -- Snapshotted from the formula: the formula's output may be re-pointed
    -- later, and a posted run must keep saying what it actually produced.
    output_inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    batches                  numeric(24, 9) NOT NULL CHECK (batches > 0),
    -- ACTUAL yield, which is what the cost is spread over. A tray that came out
    -- as 15 slices instead of 16 costs more per slice, and should.
    output_quantity          numeric(24, 9) NOT NULL CHECK (output_quantity > 0),
    material_cost_rial       bigint NOT NULL CHECK (material_cost_rial >= 0),
    conversion_cost_rial     bigint NOT NULL CHECK (conversion_cost_rial >= 0),
    total_cost_rial          bigint NOT NULL CHECK (total_cost_rial >= 0),
    note                     text,
    produced_by              uuid REFERENCES users(id) ON DELETE SET NULL,
    produced_at              timestamptz NOT NULL DEFAULT now(),
    inventory_event_id       uuid UNIQUE REFERENCES inventory_events(id) ON DELETE RESTRICT,
    reversal_of              uuid REFERENCES production_runs(id) ON DELETE RESTRICT,
    idempotency_key          text NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, idempotency_key),
    CHECK (total_cost_rial = material_cost_rial + conversion_cost_rial)
);
CREATE INDEX idx_production_runs_location_time ON production_runs (location_id, produced_at);
CREATE INDEX idx_production_runs_formula ON production_runs (formula_id);
CREATE INDEX idx_production_runs_output ON production_runs (output_inventory_item_id);
-- A run is reversed at most once.
CREATE UNIQUE INDEX uq_production_run_reversal ON production_runs (reversal_of)
    WHERE reversal_of IS NOT NULL;

-- What the run actually consumed and what it actually cost, per input. Written
-- from the exact consumption path's own posted cost, never recomputed from
-- today's avg_cost.
CREATE TABLE production_run_inputs (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    production_run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE RESTRICT,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
    quantity          numeric(24, 9) NOT NULL CHECK (quantity > 0),
    cost_rial         bigint NOT NULL CHECK (cost_rial >= 0),
    UNIQUE (production_run_id, inventory_item_id)
);
CREATE INDEX idx_production_run_inputs_item ON production_run_inputs (inventory_item_id);

-- Same posture as customer/supplier return and write-down lines (0017): a
-- posted source document's lines are immutable.
CREATE TRIGGER trg_production_run_inputs_immutable
    BEFORE UPDATE OR DELETE ON production_run_inputs
    FOR EACH ROW EXECUTE FUNCTION reject_operational_source_line_mutation();

-- ---------------------------------------------------------------------------
-- Negative-layer settlement: a production output can close open shortages of
-- the produced item (slices sold before the cake was baked), exactly as a
-- purchase receipt or a count surplus does. 0019 generalised this table from
-- purchase_items to also carry a stock count; a third source joins them here.
-- ---------------------------------------------------------------------------

ALTER TABLE inventory_negative_layer_settlements
    ADD COLUMN production_run_id uuid REFERENCES production_runs(id) ON DELETE RESTRICT;

ALTER TABLE inventory_negative_layer_settlements
    DROP CONSTRAINT chk_negative_settlement_source;
ALTER TABLE inventory_negative_layer_settlements
    ADD CONSTRAINT chk_negative_settlement_source
    CHECK (num_nonnulls(purchase_item_id, stock_count_id, production_run_id) = 1);

-- Mirrors uq_negative_settlement_stock_count: a given run settles a given layer
-- at most once, so a retried run transaction cannot double-release the same
-- provisional value.
CREATE UNIQUE INDEX uq_negative_settlement_production_run
    ON inventory_negative_layer_settlements (production_run_id, negative_layer_id)
    WHERE production_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-level security — in the same migration that creates the tables.
-- ---------------------------------------------------------------------------

ALTER TABLE production_formulas ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_formulas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_formulas FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE production_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE production_formula_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_formula_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_formula_inputs FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM production_formulas f
         WHERE f.id = production_formula_inputs.formula_id
           AND app_owns_location(f.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM production_formulas f
         WHERE f.id = production_formula_inputs.formula_id
           AND app_owns_location(f.location_id)));

ALTER TABLE production_run_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_run_inputs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_run_inputs FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM production_runs r
         WHERE r.id = production_run_inputs.production_run_id
           AND app_owns_location(r.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM production_runs r
         WHERE r.id = production_run_inputs.production_run_id
           AND app_owns_location(r.location_id)));

-- ---------------------------------------------------------------------------
-- Chart of accounts — for businesses that already exist. New businesses get
-- these from FNB_COA_TEMPLATE (src/lib/coa-template.ts).
--
-- 1310 is a wash account: a run debits it with the materials and the
-- conversion cost, then credits the whole lot back out as finished goods, so
-- it is zero the moment the run's transaction commits. It exists so the
-- transformation is legible in the ledger rather than being a single
-- inventory-to-inventory entry that says nothing.
--
-- 5180 is a contra-expense. The baker's wage is already an expense (5200) and
-- the oven's gas already an expense (5400); capitalising that effort into the
-- cake's cost must not book it a second time, so absorbing it CREDITS 5180,
-- which nets against those accounts in the P&L.
-- ---------------------------------------------------------------------------

INSERT INTO accounts (business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
FROM businesses b CROSS JOIN (VALUES
    ('1310', 'کالای در جریان ساخت', 'asset'),
    ('5180', 'هزینهٔ تبدیل جذب‌شده در تولید', 'expense')
) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reporting
--
-- One row per run, day-bucketed through app_business_date — a café that bakes
-- at 02:00 files the batch under the trading day it worked, like every other
-- report in the app.
--
-- Every additive column is SIGNED: a reversal row carries the negative of what
-- it undid, so summing any of them over a period nets correctly without the
-- reader having to know reversals exist. `unit_cost` is a rate rather than a
-- quantity, so it stays positive on both.
-- ---------------------------------------------------------------------------

CREATE VIEW v_production_summary AS
SELECT r.location_id,
       r.business_id,
       app_business_date(r.produced_at, l.timezone, l.business_day_start_minutes) AS production_date,
       r.id                                       AS production_run_id,
       r.formula_id,
       f.name                                     AS formula_name,
       r.output_inventory_item_id,
       oi.name                                    AS output_item_name,
       oi.unit                                    AS output_unit,
       (r.reversal_of IS NOT NULL)                AS is_reversal,
       (r.batches * sign.factor)                  AS batches,
       (r.output_quantity * sign.factor)          AS quantity,
       (r.material_cost_rial * sign.factor)::bigint   AS material_cost,
       (r.conversion_cost_rial * sign.factor)::bigint AS conversion_cost,
       (r.total_cost_rial * sign.factor)::bigint      AS total_cost,
       round(r.total_cost_rial / r.output_quantity)::bigint AS unit_cost,
       -- Positive when the batch yielded less than the formula promised, which
       -- is the direction that costs money.
       (((f.output_quantity * r.batches) - r.output_quantity) * sign.factor) AS yield_variance
FROM production_runs r
JOIN locations l ON l.id = r.location_id
JOIN production_formulas f ON f.id = r.formula_id
JOIN inventory_items oi ON oi.id = r.output_inventory_item_id
CROSS JOIN LATERAL (SELECT CASE WHEN r.reversal_of IS NULL THEN 1 ELSE -1 END AS factor) sign;

ALTER VIEW v_production_summary SET (security_invoker = on);
