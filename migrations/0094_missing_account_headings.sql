-- The account headings the seeded charts were missing.
--
-- Three problems, one backfill.
--
-- 1. The four retail templates (jewelry/watch/accessories/cosmetics) were each
--    written as "the generic accounts plus this trade's inventory/revenue/COGS
--    triple" and never picked up the accounts a *cross-industry* feature added
--    later. But `industry-profile.ts` puts `ledger` in CORE_MODULES: every
--    business has payroll, fixed assets, expenses and reconciliation whatever
--    it sells. So a jeweller had `2300 حقوق پرداختنی` and no `5200` to debit,
--    and `1500 اثاثه و تجهیزات` with neither side of the depreciation entry —
--    payroll accrual and monthly depreciation both failed outright with
--    `ledger_account_missing`, as did a cosmetics markdown (needs 5170) and a
--    retail supplier return settled as a receivable (needs 1210).
--
-- 2. Headings no template had at all, in any industry: discounts given (order
--    payment credits revenue *net* of them, so they were invisible in the
--    ledger), the service charge `orders` already carries a column for, bank and
--    PSP charges, a till over/short, petty cash, payroll withholdings, income
--    tax, borrowings, the owner's drawings and fixed-asset disposal. Nothing
--    posts to these automatically yet — they exist so the manual entry that
--    records them has somewhere honest to go, which is why they are deliberately
--    NOT in WELL_KNOWN_CODES (that list is the "can never be archived or
--    deleted" set) and a business that doesn't use one may simply drop it.
--
-- 3. Cheques, which had no representation anywhere: see 0095_cheques.sql. The
--    accounts land here so the whole chart moves in one step.
--
-- Additive and idempotent, the same rule `seedChartOfAccounts` and the platform
-- console's industry-change path already follow: a business that already has a
-- code — or renamed it, or archived it — is left exactly as it is.

-- Group-level (کل) accounts, hung off the five type roots.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, v.is_contra
FROM businesses b
CROSS JOIN (VALUES
  -- Tier 2 — headings every chart was missing.
  ('1130', 'تنخواه',                              'asset',     '1000', false),
  ('1240', 'اسناد دریافتنی',                      'asset',     '1000', false),
  ('2120', 'اسناد پرداختنی',                      'liability', '2000', false),
  ('2430', 'پیش‌دریافت از مشتری',                  'liability', '2000', false),
  ('2480', 'مالیات بر درآمد (عملکرد) پرداختنی',    'liability', '2000', false),
  ('2500', 'تسهیلات و وام پرداختنی',               'liability', '2000', false),
  ('3200', 'برداشت مالک',                          'equity',    '3000', true),
  ('4350', 'تخفیفات فروش',                         'revenue',   '4000', true),
  ('4920', 'سود فروش دارایی ثابت',                 'revenue',   '4000', false),
  ('5750', 'زیان فروش دارایی ثابت',                'expense',   '5000', false),
  ('5800', 'کارمزد بانکی و درگاه پرداخت',          'expense',   '5000', false),
  ('5810', 'کسری و اضافه صندوق',                   'expense',   '5000', false),
  ('5850', 'هزینه مالی (سود تسهیلات)',             'expense',   '5000', false),
  ('5860', 'هزینه چک برگشتی و جرایم بانکی',        'expense',   '5000', false),
  ('5950', 'هزینه مالیات بر درآمد',                'expense',   '5000', false)
) v(code, name, type, parent, is_contra)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
ON CONFLICT (business_id, code) DO NOTHING;

-- The service charge is F&B's: `orders.service_charge` is a café's line, and a
-- shop selling a watch over the counter has no equivalent.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, '4360', 'درآمد حق سرویس', 'revenue'::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '4000'
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

-- Tier 1 — the generic accounts only the four retail charts were missing. F&B
-- has carried all of these since Phase 22, so it is excluded rather than
-- relying on the ON CONFLICT to absorb five no-op rows per café.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
CROSS JOIN (VALUES
  ('1210', 'دریافتنی از تأمین‌کننده',    'asset',   '1000'),
  ('5170', 'هزینه کاهش ارزش موجودی',     'expense', '5000'),
  ('5200', 'حقوق و دستمزد',              'expense', '5000'),
  ('5500', 'ملزومات مصرفی',              'expense', '5000'),
  ('5700', 'هزینه استهلاک',              'expense', '5000')
) v(code, name, type, parent)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
WHERE b.industry <> 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

-- Sub-accounts (معین). Runs after the block above so 1240 and 2120 exist to be
-- parented onto; a business whose chart has no such parent is skipped by the
-- JOIN rather than getting an orphan.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'moein'::account_level, v.is_contra
FROM businesses b
CROSS JOIN (VALUES
  -- Where a cheque we took is right now. An endorsed one has no account here on
  -- purpose — see 0095_cheques.sql and WELL_KNOWN_CODES' note.
  ('1241', 'چک‌های نزد صندوق',           'asset',     '1240', false),
  ('1242', 'چک‌های در جریان وصول',       'asset',     '1240', false),
  ('1244', 'چک‌های برگشتی',              'asset',     '1240', false),
  -- Cheques we wrote.
  ('2121', 'چک‌های صادرشده در جریان',    'liability', '2120', false),
  ('2122', 'چک‌های پرداختنی برگشتی',     'liability', '2120', false),
  -- Payroll withholdings. `accruePayroll` posts gross wages today; these are
  -- where the deductions belong, and what a manual payroll entry needs meanwhile.
  ('2460', 'بیمه پرداختنی',              'liability', '2300', false),
  ('2470', 'مالیات حقوق پرداختنی',       'liability', '2300', false)
) v(code, name, type, parent, is_contra)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
ON CONFLICT (business_id, code) DO NOTHING;

-- Accumulated depreciation is a معین under اثاثه و تجهیزات and a contra-asset,
-- exactly as migration 0058 created it for F&B.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, '1510', 'استهلاک انباشته', 'asset'::account_type, 'moein'::account_level, true
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '1500'
WHERE b.industry <> 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
