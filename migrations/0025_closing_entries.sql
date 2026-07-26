-- Phase 16 — year-end closing entries.
--
-- Adds the "Retained Earnings" equity account (code 3800) new businesses get
-- seeded with going forward (coa-template.ts), and backfills it onto every
-- business that already exists — same pattern as migration 0017 when a new
-- well-known account was introduced after go-live. A business that removed
-- this account while customizing its chart is free to do so again; closing a
-- year with it missing is rejected the same way any other missing
-- well-known account is (MissingLedgerAccountError -> 409).

INSERT INTO accounts (business_id, code, name, type)
SELECT b.id, v.code, v.name, v.type::account_type
FROM businesses b CROSS JOIN (VALUES
  ('3800', 'سود (زیان) انباشته', 'equity')
) v(code, name, type)
ON CONFLICT (business_id, code) DO NOTHING;
