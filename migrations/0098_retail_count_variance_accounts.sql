-- The count-variance accounts the four retail charts never had.
--
-- Phase 6 gave F&B a physical stock count, and with it `5160 هزینه کسری و
-- مغایرت شمارش` and `4910 درآمد اضافه شمارش موجودی` — the two sides of "what we
-- counted is not what the system thought". The retail item model
-- (`items`/`item_stock`, Phase 21) never had a count at all, so neither account
-- was ever added to the jewelry/watch/accessories/cosmetics templates.
--
-- Adding the count needs somewhere to post its variance, and 5160 cannot be it:
-- the cosmetics chart already spends that code on «کالای منقضی و تستر» (0080's
-- phase — an *identified* loss: stock that expired, or a tester opened on
-- purpose). Unexplained shrinkage found at a count is a different fact, and
-- folding the two together would make a cosmetics shop's expiry line unreadable.
-- So the shortage side gets a fresh code, `5190`, and gets it in all four retail
-- trades rather than 5160-in-three-and-5190-in-cosmetics — one code means the
-- posting rule stays a rule instead of a per-industry account lookup.
--
-- The surplus side reuses 4910 unchanged, name included: a count surplus means
-- the same thing whatever the shop sells, and the code was free in all four
-- retail charts.
--
-- Additive and idempotent, exactly as 0094_missing_account_headings.sql:
-- a business that already has the code — or renamed it, or archived it — is
-- left as it is. F&B is excluded rather than relying on ON CONFLICT to absorb
-- a no-op row per café.

INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
CROSS JOIN (VALUES
  ('4910', 'درآمد اضافه شمارش موجودی', 'revenue', '4000'),
  ('5190', 'هزینه کسری انبارگردانی',   'expense', '5000')
) v(code, name, type, parent)
JOIN accounts p ON p.business_id = b.id AND p.code = v.parent
WHERE b.industry <> 'food_service'
ON CONFLICT (business_id, code) DO NOTHING;
