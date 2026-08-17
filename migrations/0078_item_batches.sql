-- Phase 27 Wave 2 — batch, expiry and FEFO for the retail item model.
--
-- Cosmetics stock is governed by expiry, and the product had no concept of
-- either. `inventory_lots` (0006) is a FIFO *cost* layer with no lot number
-- and no traceability, and it is F&B-only — deliberately not reused here.
--
-- `item_batches` is a satellite of `items`, exactly the way `item_stock` is:
-- for a `tracking='batch'` item the batches are authoritative and
-- `item_stock.quantity` is their rollup (asserted by an integration test, not
-- left as a convention). A batch carries the lot number, its expiry date, its
-- quantity and unit cost, the received date and a supplier reference — enough
-- to sell first-expired-first-out (src/lib/fefo.ts) and to write off what
-- expired.
--
-- RLS in the same migration, scoped through items.location_id — the pattern
-- item_stock (0068) and item_variant_attributes (0050) use.

-- 'batch' joins the existing tracking modes: none/serial/weight.
ALTER TABLE items DROP CONSTRAINT items_tracking_check;
ALTER TABLE items ADD CONSTRAINT items_tracking_check
    CHECK (tracking IN ('none', 'serial', 'weight', 'batch'));

CREATE TABLE item_batches (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id            uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    -- Batch/lot number — the unit of traceability the shop prints on the label
    -- and the receipt. Unique within an item.
    batch_number       text NOT NULL,
    -- Expiry date. Nullable: a batch-tracked item may arrive with no stated
    -- expiry; fefo.ts treats a null expiry as "never first", i.e. it is
    -- consumed only after every dated batch.
    expiry_date        date,
    -- numeric(24,9) for the same reason item_stock.quantity uses it: it is
    -- the precision this schema already spends on quantities.
    quantity           numeric(24, 9) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    -- What this batch cost per unit (Rial, whole), as received.
    unit_cost          bigint CHECK (unit_cost IS NULL OR unit_cost >= 0),
    received_date      date NOT NULL DEFAULT CURRENT_DATE,
    supplier_reference text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (item_id, batch_number)
);

CREATE INDEX idx_item_batches_item ON item_batches (item_id);
CREATE INDEX idx_item_batches_expiry ON item_batches (expiry_date) WHERE expiry_date IS NOT NULL;

ALTER TABLE item_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_batches FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_batches.item_id AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_batches.item_id AND app_owns_location(i.location_id)));
