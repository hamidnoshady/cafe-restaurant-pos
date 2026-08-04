-- ---------------------------------------------------------------------------
-- Revenue split by sales channel & platform-commission expense
-- (Phase 22 Wave 4, issue #160 §4)
-- ---------------------------------------------------------------------------
-- Order payment now credits one of three channel-specific revenue accounts
-- (dine-in/takeaway/delivery, keyed off orders.type — existed since Phase 0,
-- no new schema needed) instead of one flat "sales revenue" account.
-- salesRevenue (4300) stays in the chart for historical entries and
-- manual/other use, but stops receiving new auto-postings.
--
-- Backfilled only onto food_service businesses — a jewelry business's chart
-- (JEWELRY_COA_TEMPLATE) has no "dine-in" concept and never will.
--
-- Same pattern migrations 0017/0025/0032 used for earlier well-known-account
-- additions, extended to also set parent_id/level correctly (Wave 2's
-- account-hierarchy metadata) rather than leaving new rows parent-less the
-- way those three did — worth doing properly now that `level` is a real,
-- queryable concept.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '4000'
CROSS JOIN (VALUES
  ('4310', 'فروش حضوری (سالن)', 'revenue'),
  ('4320', 'فروش بیرون‌بر', 'revenue'),
  ('4330', 'فروش ارسالی', 'revenue')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;

-- Platform-commission expense (§4's "کمیسیون پلتفرم‌ها") — settled via the
-- manual-journal workflow, the same "new well-known account, not deep
-- posting-path integration" pattern Phase 16 used for input VAT (there's no
-- "platform" order-source concept in the schema yet to auto-post against).
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
JOIN accounts p ON p.business_id = b.id AND p.code = '5000'
CROSS JOIN (VALUES
  ('5650', 'کارمزد پلتفرم‌های سفارش آنلاین', 'expense')
) v(code, name, type)
WHERE b.industry = 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
