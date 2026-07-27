-- Phase 16 — VAT/tax reporting: output vs input VAT and a payable position.
--
-- Output VAT has posted to vatPayable (2200) since Phase 7 — every order
-- payment credits it. Input VAT (tax paid on purchases, recoverable) had no
-- account to post to at all; this adds "VAT receivable" (code 1220) as a new
-- well-known account new businesses get seeded with going forward
-- (coa-template.ts), and backfills it onto every business that already
-- exists — same pattern as migration 0025's Retained Earnings backfill.
-- Recording input VAT is a manual-journal entry against this account
-- (Debit VAT receivable / Credit Accounts Payable or Cash) — deliberately
-- not wired into purchase receiving itself, which stays untouched.

INSERT INTO accounts (business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
FROM businesses b CROSS JOIN (VALUES
  ('1220', 'مالیات بر ارزش افزوده خرید (قابل استرداد)', 'asset')
) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;
