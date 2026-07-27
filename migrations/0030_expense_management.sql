-- Phase 16 — expense management: categorised operating expenses (rent,
-- utilities, marketing, …), recorded as paid — not a bill owed, which is
-- what the AP subledger already models for supplier purchases specifically.
-- The "category" is simply the expense account itself (accounts already has
-- 5200-5900 for exactly this), so no separate taxonomy is invented.
--
-- Each row is always posted alongside a journal entry (Debit the chosen
-- expense account / Credit the chosen payment account, source_type =
-- 'expense', source_id = this row's id) in the same transaction — see
-- src/lib/expense-service.ts. Mirrors ar_receipts/ap_payments: no entry_id
-- column here, the link is one-directional via journal_entries.source_id.
--
-- Attachments and recurring expenses are deferred (see the phase doc's
-- decisions) — nothing in the exit criteria depends on either.

CREATE TABLE expenses (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id         uuid REFERENCES locations(id) ON DELETE SET NULL,
    account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    payment_account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount              bigint NOT NULL CHECK (amount > 0),
    expense_date        date NOT NULL DEFAULT CURRENT_DATE,
    vendor              text,
    memo                text NOT NULL,
    created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_business ON expenses (business_id);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
