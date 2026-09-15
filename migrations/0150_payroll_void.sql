-- Phase 16 follow-up — voiding a payroll run.
--
-- A payroll run was write-once until now: once accrued (and possibly paid) its
-- journal entries stood for ever, so a run created for the wrong period or the
-- wrong wages could only be undone by hand-writing reversing entries — the one
-- ledger surface in the app with no reversal path, while manual entries, order
-- payments, stock counts and production runs all have one.
--
-- Voiding a run posts the exact mirror of each of its still-standing postings
-- (the accrual, and the payment if it was paid) through the same
-- postExactMirrorEntry() every other reversal uses — so it is dated today
-- rather than backdated into a possibly-locked period, and is refused when
-- today's fiscal period is locked, exactly like a manual reversal. See
-- src/lib/payroll-service.ts (voidPayrollRun).
--
-- 'voided' joins the status enum; voided_at/voided_by record who undid it and
-- when, mirroring journal_entries.reversed_at/reversed_by.

ALTER TABLE payroll_runs
    DROP CONSTRAINT IF EXISTS payroll_runs_status_check;
ALTER TABLE payroll_runs
    ADD CONSTRAINT payroll_runs_status_check CHECK (status IN ('accrued', 'paid', 'voided'));

ALTER TABLE payroll_runs
    ADD COLUMN voided_at timestamptz,
    ADD COLUMN voided_by uuid REFERENCES users(id) ON DELETE SET NULL;
