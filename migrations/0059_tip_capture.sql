-- ---------------------------------------------------------------------------
-- Tip capture (انعام کارکنان) — issue #160 §4
-- ---------------------------------------------------------------------------
-- Product decisions confirmed with the product owner before writing any
-- code (this feature was explicitly deferred out of Wave 4 pending exactly
-- these three questions):
--
-- 1. A tip is entered as a separate amount at checkout, added on top of the
--    bill — orders.total keeps meaning exactly what it always has (the
--    bill), so every existing report/export/reconciliation that reads it
--    stays correct unmodified. tip_amount is the new, separate field.
-- 2. A tip is a pass-through liability owed to staff, not business revenue
--    — not part of income, not subject to VAT. Distributing it to staff is
--    a manual-journal entry against tipsPayable, the same "new well-known
--    account, settled via the existing manual-journal workflow" pattern
--    Phase 16 used for input VAT and Wave 4 used for platform commission —
--    there's no per-staff attribution model to build a dedicated payout
--    flow against yet.
-- 3. Pooled only for v1 — no per-staff attribution. Matches every other
--    phase's "start simple, revisit if asked" pattern.

ALTER TABLE orders
    ADD COLUMN tip_amount bigint NOT NULL DEFAULT 0 CHECK (tip_amount >= 0);

-- New well-known account, backfilled onto every existing food_service
-- business only — a jewelry business has no service-staff tip concept, same
-- scoping Wave 4/5 already used for their own new accounts.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '2000'
CROSS JOIN (VALUES
  ('2400', 'انعام پرداختنی', 'liability')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
