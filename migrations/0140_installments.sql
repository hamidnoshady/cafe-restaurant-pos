-- Installment schedules (اقساط) — the payment-plan tracker the retail trades
-- asked for: a receivable plan splits what a customer owes into dated slices,
-- a payable plan does the same for what the business owes a supplier.
--
-- A plan is *schedule data*. The accounting happens per slice, when the slice
-- is settled: a receivable slice posts exactly what receivePayment posts
-- (an ar_receipts row + Debit Cash/Bank / Credit Accounts Receivable) and a
-- payable slice exactly what payBill posts (an ap_payments row + the mirror
-- entry), both inside the same transaction that marks the slice paid — so the
-- plan can never drift from the ledger. Creating a zero-interest plan posts
-- nothing: the receivable side of an invoice-based plan was already posted by
-- the credit sale, and a party-based plan is a schedule against balances that
-- already exist in the subledgers. If a plan adds interest, the service accrues
-- only that added amount to A/R or A/P so later settlements cannot over-clear
-- the original balance.

CREATE TABLE installments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
    direction         text NOT NULL CHECK (direction IN ('receivable', 'payable')),
    -- 'invoice' plans split one retail invoice; 'party' plans are a free
    -- schedule against a counterparty's open balance.
    source            text NOT NULL CHECK (source IN ('party', 'invoice')),
    party_id          uuid REFERENCES parties(id) ON DELETE SET NULL,
    invoice_order_id  uuid REFERENCES orders(id) ON DELETE SET NULL,
    -- Integer Rial, like every money column.
    principal         bigint NOT NULL CHECK (principal > 0),
    down_payment      bigint NOT NULL DEFAULT 0 CHECK (down_payment >= 0),
    interest_percent  numeric(5,2) NOT NULL DEFAULT 0 CHECK (interest_percent >= 0),
    late_fee_percent  numeric(5,2) NOT NULL DEFAULT 0 CHECK (late_fee_percent >= 0),
    installment_count integer NOT NULL CHECK (installment_count > 0),
    interval_months   integer NOT NULL CHECK (interval_months > 0),
    first_due_date    date NOT NULL,
    note              text,
    created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_installments_business ON installments (business_id, direction);
CREATE INDEX idx_installments_party ON installments (business_id, party_id);

CREATE TABLE installment_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    installment_id uuid NOT NULL REFERENCES installments(id) ON DELETE CASCADE,
    seq            integer NOT NULL,
    due_date       date NOT NULL,
    amount         bigint NOT NULL CHECK (amount > 0),
    paid_at        timestamptz,
    paid_method    text CHECK (paid_method IN ('cash', 'bank')),
    paid_memo      text,
    -- The subledger row this slice settled through, when it has one.
    receipt_id     uuid,
    payment_id     uuid,
    UNIQUE (installment_id, seq)
);
CREATE INDEX idx_installment_items_due ON installment_items (installment_id, due_date);

ALTER TABLE installments ENABLE ROW LEVEL SECURITY;
ALTER TABLE installments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON installments FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- installment_items inherits its tenancy from the parent plan; RLS on the
-- child enforces it directly so no query can skip the join.
ALTER TABLE installment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE installment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON installment_items FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM installments p
         WHERE p.id = installment_id
           AND (app_rls_bypass() OR p.business_id = app_current_business())))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM installments p
         WHERE p.id = installment_id
           AND (app_rls_bypass() OR p.business_id = app_current_business())));
