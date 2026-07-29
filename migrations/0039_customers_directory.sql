-- Customers directory: the `customers` table (Phase 1) has been a thin
-- lookup used only by the AR subledger's credit-payment picker. This adds
-- what a standalone customer-management screen needs — a soft-delete flag
-- (financial history, via ar_receipts.customer_id ON DELETE RESTRICT and
-- orders.customer_id, must never be orphaned by a hard delete) and an
-- updated_at so edits are auditable. `address`/`notes` already exist on the
-- table since Phase 1 but had no reader/writer until now.

ALTER TABLE customers ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
