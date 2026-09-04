-- ============================================================================
-- 0135_marketing_expense_message_accounts.sql — Phase 37 Wave 4.
--
-- Two sides of the messaging-cost document, guaranteed on *every* business's
-- chart so no industry posts a campaign cost into `ledger_account_missing`:
--
--   5600  هزینهٔ تبلیغات و بازاریابی   (expense)  — already on every template;
--                                              this pass backfills any existing
--                                              business that somehow lacks it.
--   2455  پرداختنی به پلتفرم (اعتبار پیام)  (liability) — the credit side that
--                                              represents message credits the
--                                              business actually consumed.
--
-- Additive and idempotent, the same rule `seedChartOfAccounts` and the console's
-- industry-change path follow: a business that already has a code — or renamed
-- or archived it — is left exactly as it is. No existing account is rewritten.
-- ============================================================================

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, v.is_contra
FROM businesses b
CROSS JOIN (VALUES
  ('5600', 'بازاریابی و تبلیغات',               'expense',   '5000', false),
  ('2455', 'پرداختنی به پلتفرم (اعتبار پیام)',    'liability', '2000', false)
) v(code, name, type, parent, is_contra)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
ON CONFLICT (business_id, code) DO NOTHING;
