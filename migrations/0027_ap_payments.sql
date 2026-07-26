-- Phase 16 — AP subledger: payments against a supplier's outstanding balance.
--
-- Mirrors migration 0026's ar_receipts. A purchase received with the
-- 'credit' settlement method already posts the bill side (Debit Inventory /
-- Credit Accounts Payable, via postExactPurchaseEntry) and, since this
-- migration's accompanying app changes, requires a supplier. This table is
-- the other half: recording the business later paying some of it back. Each
-- row is always posted alongside a journal entry (Debit Accounts Payable /
-- Credit Cash/Bank-Clearing, source_type = 'ap_payment', source_id = this
-- row's id) in the same transaction — see src/lib/ap-service.ts.
--
-- suppliers has no business_id column (location_id NOT NULL only, unlike
-- customers), so unlike ar_receipts this can't reference suppliers with an
-- ON DELETE RESTRICT FK scoped the same way as the business check — the
-- business match is instead verified in application code (ap-service.ts)
-- before insert, same as every other cross-table check in this schema that
-- can't be expressed as a single FK.

CREATE TABLE ap_payments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid REFERENCES locations(id) ON DELETE SET NULL,
    supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    payment_date date NOT NULL DEFAULT CURRENT_DATE,
    method       text NOT NULL CHECK (method IN ('cash', 'bank')),
    amount       bigint NOT NULL CHECK (amount > 0),
    memo         text,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ap_payments_business_supplier ON ap_payments (business_id, supplier_id);

ALTER TABLE ap_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ap_payments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
