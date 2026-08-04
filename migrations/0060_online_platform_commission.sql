-- ---------------------------------------------------------------------------
-- Online ordering platform commission (SnapFood) — issue #160 §4
-- ---------------------------------------------------------------------------
-- The last of Wave 4's three deliberate deferrals. Product direction from the
-- business owner: only SnapFood for now; its commission rate varies by
-- contract, so it's a business-configurable setting (SETTING_KEYS.onlinePlatforms
-- in src/lib/settings.ts), not a hardcoded %; there's no automated feed from
-- SnapFood's PartnerFood desktop app (no documented local integration
-- surface), so a SnapFood order is recorded the same way every other order
-- is — the cashier picks it as the payment method at checkout, same as
-- cash/card/credit.
--
-- Money flow: SnapFood collects from the customer, then remits (order total
-- + tip - commission) to the business later, on their own settlement
-- schedule. That's a genuine receivable, not cash-in-hand, so unlike
-- cash/card/credit's existing debit accounts, a SnapFood-paid order debits
-- this new asset instead — the existing platformCommissionExpense account
-- (5650, added in Wave 4) absorbs the commission itself. See
-- postExactOrderPaymentEntry (ledger-service.ts) for the split.

-- A SnapFood order is recorded as a payment method, same as cash/card/credit
-- (see ledger-service.ts's postExactOrderPaymentEntry) — the payments table's
-- method column is a Postgres enum, so it needs the new value added.
ALTER TYPE payment_method ADD VALUE 'snappfood';

-- New well-known asset account, backfilled onto every existing food_service
-- business only, same scoping every other Wave 4/5/8 account addition used.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '1000'
CROSS JOIN (VALUES
  ('1230', 'مطالبات از پلتفرم‌های سفارش آنلاین', 'asset')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
