-- Phase 16 — payroll entries: staff cost accrual and payment postings,
-- journal-level (no tax tables, insurance, or payslips — that's a payroll
-- engine, explicitly out of scope for this phase).
--
-- A payroll run accrues first (Debit salariesExpense / Credit
-- salariesPayable, source_type='payroll_accrual') against every active
-- staff member's current monthly_wage, snapshotted per person into
-- payroll_run_lines so the total stays auditable even after wages change
-- later. Paying it posts the other half (Debit salariesPayable / Credit
-- Cash/Bank-Clearing, source_type='payroll_payment') — see
-- src/lib/payroll-service.ts. Mirrors ar_receipts/ap_payments: no entry_id
-- column, the link to each posting is one-directional via
-- journal_entries.source_type/source_id.

ALTER TABLE users
    ADD COLUMN monthly_wage bigint CHECK (monthly_wage IS NULL OR monthly_wage >= 0);

CREATE TABLE payroll_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES locations(id) ON DELETE SET NULL,
    period_label  text NOT NULL,
    status        text NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'paid')),
    total_amount  bigint NOT NULL CHECK (total_amount > 0),
    accrual_date  date NOT NULL DEFAULT CURRENT_DATE,
    paid_date     date,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payroll_runs_business ON payroll_runs (business_id);

CREATE TABLE payroll_run_lines (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id   uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    amount   bigint NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_payroll_run_lines_run ON payroll_run_lines (run_id);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_runs FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE payroll_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payroll_run_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM payroll_runs r
         WHERE r.id = payroll_run_lines.run_id
           AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM payroll_runs r
         WHERE r.id = payroll_run_lines.run_id
           AND r.business_id = app_current_business()));
