-- Phase 16 — AR subledger: receipts against a customer's outstanding balance.
--
-- An order paid with the 'credit' method already posts the invoice side
-- (Debit Accounts Receivable / Credit Sales Revenue + Tax, via
-- postExactOrderPaymentEntry) and, since this migration, carries a
-- customer_id. This table is the other half: recording the customer later
-- paying some of it back. Each row is always posted alongside a journal
-- entry (Debit Cash/Bank-Clearing / Credit Accounts Receivable,
-- source_type = 'ar_receipt', source_id = this row's id) in the same
-- transaction — see src/lib/ar-service.ts.

CREATE TABLE ar_receipts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
    customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    receipt_date date NOT NULL DEFAULT CURRENT_DATE,
    method       text NOT NULL CHECK (method IN ('cash', 'bank')),
    amount       bigint NOT NULL CHECK (amount > 0),
    memo         text,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ar_receipts_business_customer ON ar_receipts (business_id, customer_id);

ALTER TABLE ar_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ar_receipts FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
