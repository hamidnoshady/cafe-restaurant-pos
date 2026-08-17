-- Phase 27 Wave 4 — barcodes (بارکد) for the four retail trades.
--
-- Until now the only "barcode" in the product was a comment about scanner
-- typing speed: items.sku is a search hint, not a scannable identity. This
-- gives a saleable item a set of real codes (a supplier EAN-13/UPC, or an
-- internal one generated for stock that arrives without one), each unique
-- per branch so a scan can never be ambiguous across the counter.
--
-- location_id is denormalised from items.location_id (items never move
-- between branches) so that the UNIQUE (location_id, code) constraint can
-- express "one code, one item, per branch" — a per-item unique index cannot.
-- The RLS policy still scopes *through* items.location_id (the same shape as
-- item_stock) and additionally requires the denormalised column to agree,
-- so a row whose location drifted from its item is invisible to everyone,
-- not just to the branch it names.

CREATE TABLE item_barcodes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    -- The scannable code, folded to ASCII digits (Persian/Arabic-Indic digits
    -- are normalised by src/lib/barcode.ts before it ever reaches here).
    code        text NOT NULL,
    -- 'EAN13' and 'UPC' are supplier codes (UPC-A, 12 digits); 'internal' is a
    -- generated code we mint for stock that arrives without one.
    symbology   text NOT NULL DEFAULT 'internal'
                  CHECK (symbology IN ('EAN13', 'UPC', 'internal')),
    -- Human-readable note for a supplier code (e.g. the supplier's name),
    -- shown next to the code on the label screen. Null for internal codes.
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, code)
);

CREATE INDEX idx_item_barcodes_item ON item_barcodes (item_id);
CREATE INDEX idx_item_barcodes_location_code ON item_barcodes (location_id, code);

ALTER TABLE item_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_barcodes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON item_barcodes FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_barcodes.item_id
           AND i.location_id = item_barcodes.location_id
           AND app_owns_location(i.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM items i
         WHERE i.id = item_barcodes.item_id
           AND i.location_id = item_barcodes.location_id
           AND app_owns_location(i.location_id)));
