-- Phase 27 Wave 11 — accessories/cosmetics merchandising analytics.
--
-- Season and collection are free-text tags on an item so a shop can ask
-- "how much of the autumn collection sold through", answered from the same
-- sale events the sales report already reads (no new posting, no new table
-- for the report itself).

ALTER TABLE items
    ADD COLUMN collection text,
    ADD COLUMN season text;

CREATE INDEX idx_items_collection ON items (location_id, collection)
    WHERE collection IS NOT NULL;
CREATE INDEX idx_items_season ON items (location_id, season)
    WHERE season IS NOT NULL;
