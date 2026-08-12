-- Purchase and expense reporting views.
--
-- Spend was reportable only through v_ledger_by_account, which sees the
-- postings but not the operational grain: it can't answer "which supplier did
-- we buy the most from", "how much of that item did we buy", or "which payment
-- account did the rent go out of". These two views expose that grain so the
-- report builder can slice spend the same way it already slices sales.
--
-- Money stays integer Rial and day buckets use the branch's own timezone,
-- exactly as the 0008 views do, so a purchase report reconciles with a sales
-- report over the same range.

-- One row per purchase *line* (not per purchase), so the item and quantity
-- dimensions are available. `cost` is purchase_items.extended_cost, which sums
-- back to purchases.total per purchase — line-level sums never double-count.
-- Counting purchases at this grain needs count(DISTINCT purchase_id), which is
-- what the whitelist's count_distinct aggregation is for.
--
-- Every status is included (draft/ordered/received/cancelled) rather than just
-- received: committed-but-not-yet-received spend is a real question, and status
-- is both a dimension and a filter so either view of it is one click away.
CREATE VIEW v_purchase_summary AS
SELECT
    p.location_id,
    l.business_id,
    (p.created_at AT TIME ZONE l.timezone)::date  AS purchase_date,
    (p.received_at AT TIME ZONE l.timezone)::date AS received_date,
    p.id                                          AS purchase_id,
    p.status::text                                AS status,
    p.supplier_id,
    s.name                                        AS supplier_name,
    pi.inventory_item_id,
    ii.name                                       AS item_name,
    ii.unit,
    pi.quantity,
    pi.unit_cost,
    pi.extended_cost                              AS cost
FROM purchase_items pi
JOIN purchases p ON p.id = pi.purchase_id
JOIN locations l ON l.id = p.location_id
JOIN inventory_items ii ON ii.id = pi.inventory_item_id
LEFT JOIN suppliers s ON s.id = p.supplier_id;

-- One row per expense. The "category" is the expense account itself (0030
-- invents no separate taxonomy), and the payment account is what it was paid
-- out of — neither is derivable from v_ledger_by_account without guessing which
-- side of the entry is which. expense_date is already a plain date, so unlike
-- the purchase view above there is no timezone conversion to do.
CREATE VIEW v_expense_summary AS
SELECT
    e.business_id,
    e.location_id,
    e.expense_date,
    e.id                AS expense_id,
    e.account_id,
    a.code              AS account_code,
    a.name              AS account_name,
    e.payment_account_id,
    pa.code             AS payment_account_code,
    pa.name             AS payment_account_name,
    e.vendor,
    e.memo,
    e.amount
FROM expenses e
JOIN accounts a ON a.id = e.account_id
JOIN accounts pa ON pa.id = e.payment_account_id;

-- 0021's blanket loop already ran, so a view created after it has to opt in
-- explicitly or it runs with its owner's rights and bypasses every RLS policy
-- (integration/tenant-isolation.integration.test.ts asserts this).
ALTER VIEW v_purchase_summary SET (security_invoker = on);
ALTER VIEW v_expense_summary SET (security_invoker = on);
