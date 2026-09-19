-- The product form treats tax rates as percentages. Migration 0140 only put a
-- lower bound on these two columns, so an API client could persist 101..999.99
-- and later make an invoice calculation nonsensical. NOT VALID preserves any
-- historical bad row for explicit review while enforcing the correct range on
-- every new or updated product immediately.
ALTER TABLE items
    ADD CONSTRAINT items_tax_sale_percent_range
        CHECK (tax_sale_percent IS NULL OR tax_sale_percent BETWEEN 0 AND 100) NOT VALID,
    ADD CONSTRAINT items_tax_purchase_percent_range
        CHECK (tax_purchase_percent IS NULL OR tax_purchase_percent BETWEEN 0 AND 100) NOT VALID;
