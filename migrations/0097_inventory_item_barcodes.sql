-- Warehouse counting — barcodes (بارکد) for F&B raw-ingredient stock.
--
-- Phase 27 Wave 4 gave the four *retail* trades scannable identities
-- (item_barcodes → items). F&B's inventory_items never got one: its `sku` is a
-- search hint (src/lib/inventory-search.ts), not something a scanner emits, so
-- a physical stock count of a large store room could only ever be done by
-- finding each ingredient in a list and typing a number.
--
-- This is the same table, one model over: a set of real codes per ingredient,
-- unique per branch, so a handheld scanner can drive a count. The codes
-- themselves are minted and validated by the *existing* pure helpers in
-- src/lib/barcode.ts (EAN-13/UPC-A check digits, GS1 in-store prefix `2` for
-- internal codes) — deliberately not a second code format, so one scanner
-- configuration reads both models' labels.
--
-- Shape follows migrations/0080_item_barcodes.sql exactly, including *why*
-- location_id is denormalised from inventory_items.location_id (ingredients
-- never move between branches): the UNIQUE (location_id, code) constraint is
-- what expresses "one code, one ingredient, per branch", and a per-item unique
-- index cannot say that. The RLS policy scopes *through* inventory_items and
-- additionally requires the denormalised column to agree, so a row whose
-- location drifted from its item is invisible to everyone rather than visible
-- to the branch it names.

CREATE TABLE inventory_item_barcodes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    -- The scannable code, folded to ASCII digits (Persian/Arabic-Indic digits
    -- are normalised by src/lib/barcode.ts before it ever reaches here).
    code              text NOT NULL,
    -- 'EAN13' and 'UPC' are supplier codes read off the packaging a delivery
    -- arrives in; 'internal' is a code we mint for stock that has none.
    symbology         text NOT NULL DEFAULT 'internal'
                        CHECK (symbology IN ('EAN13', 'UPC', 'internal')),
    -- Human-readable note for a supplier code (e.g. the supplier's name),
    -- shown next to the code on the label screen. Null for internal codes.
    note              text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, code)
);

CREATE INDEX idx_inventory_item_barcodes_item ON inventory_item_barcodes (inventory_item_id);
CREATE INDEX idx_inventory_item_barcodes_location_code ON inventory_item_barcodes (location_id, code);

ALTER TABLE inventory_item_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_item_barcodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_item_barcodes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_items i
         WHERE i.id = inventory_item_barcodes.inventory_item_id
           AND i.location_id = inventory_item_barcodes.location_id
           AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_items i
         WHERE i.id = inventory_item_barcodes.inventory_item_id
           AND i.location_id = inventory_item_barcodes.location_id
           AND app_owns_location(i.location_id)));
