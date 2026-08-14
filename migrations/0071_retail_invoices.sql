-- Phase 25 Wave 3 — a sale document for the retail industries.
--
-- Jewelry, watch and accessories sales posted straight from an admin panel
-- into the ledger (gold-sales-service.ts, watch-sales-service.ts,
-- accessories-service.ts): a domain event per sale, and nothing else. No
-- order, no customer, no line items, no invoice number, no printable
-- فاکتور, and nothing in سفارش‌ها or in any sales report. A shop's main daily
-- act -- writing an invoice for a customer buying two rings and a chain --
-- had no record at all.
--
-- Rather than a parallel invoices/invoice_lines pair, a retail invoice IS an
-- order. `orders`/`order_items` already carry per-location sequential
-- numbering, payments, customer linkage, the receipt/print pipeline, the
-- orders list and the reporting joins; duplicating those for retail would be
-- a second implementation of solved problems. What they lacked was a way to
-- point a line at Phase 21's generic item model, and somewhere to keep the
-- gold price breakdown.
--
-- No new table, so no new RLS policy is required: both tables are already
-- tenant-scoped through `location_id` (migration 0021), and these columns
-- inherit that.

-- 'retail' joins dine_in/takeaway/delivery. Phase 22 Wave 4 splits sales
-- revenue by orders.type, so retail sales land in their own revenue account
-- by the mechanism that already exists.
ALTER TYPE order_type ADD VALUE IF NOT EXISTS 'retail';

ALTER TABLE order_items
    -- The generic-item counterpart of the existing nullable `menu_item_id`.
    -- Nullable for the same reason that one is: `name_snapshot` and
    -- `unit_price` are the record of what was sold, and a line survives its
    -- catalogue row being deleted.
    ADD COLUMN item_id uuid REFERENCES items(id) ON DELETE SET NULL,
    -- The gold price breakdown, in integer Rial, as computed at sale time by
    -- computeGoldSalePrice (src/lib/gold-pricing.ts). Kept per line rather
    -- than recomputed for the invoice, because the components depend on that
    -- day's gold rate and on اجرت/سود percentages the cashier chose: a
    -- reprint next month must show what the customer was actually charged.
    -- Null on every non-gold line, which is every line in a café.
    ADD COLUMN metal_value   bigint,
    ADD COLUMN making_charge bigint,
    ADD COLUMN profit        bigint;

CREATE INDEX idx_order_items_item ON order_items (item_id) WHERE item_id IS NOT NULL;
