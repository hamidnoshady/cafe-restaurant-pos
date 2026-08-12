-- A purchase's own date, chosen when it is entered.
--
-- Until now `created_at` was the only date a purchase had, so the purchases
-- list, its "از تاریخ / تا تاریخ" filters, and v_purchase_summary all reported a
-- purchase under the day it happened to be typed in. Invoices arrive late: a
-- delivery from Monday entered on Thursday belongs to Monday, and there was no
-- way to say so.
--
-- This is the split expenses already make (expenses.expense_date, migration
-- 0030): a user-chosen business date next to an untouched created_at audit
-- stamp, so "entered Thursday, dated Monday" is representable and the record of
-- when the row was actually written survives.
--
-- Only the purchase document is dated here. Receiving still stamps received_at
-- and posts its journal entry at receipt time — stock arrives, and is costed,
-- when it arrives, not when the invoice was written.

ALTER TABLE purchases ADD COLUMN purchase_date date;

-- Backfilled with the exact expression v_purchase_summary used, so every
-- existing purchase keeps the date it has always reported under and a report
-- spanning this migration stays comparable.
UPDATE purchases p
   SET purchase_date = (p.created_at AT TIME ZONE l.timezone)::date
  FROM locations l
 WHERE l.id = p.location_id;

-- CURRENT_DATE is the server's day, not the branch's; it is only the backstop
-- for a writer that supplies nothing. The POST handler passes the branch-local
-- day explicitly (`now() AT TIME ZONE l.timezone`), the same way shift-service
-- and rollup-service decide what "today" means.
ALTER TABLE purchases
    ALTER COLUMN purchase_date SET DEFAULT CURRENT_DATE,
    ALTER COLUMN purchase_date SET NOT NULL;

-- purchase_date replaces the created_at expression as the view's purchase date:
-- same column name, same `date` type, so this is a definition swap the report
-- builder's whitelist (dateColumn: "purchase_date") needs no change for.
CREATE OR REPLACE VIEW v_purchase_summary AS
SELECT
    p.location_id,
    l.business_id,
    p.purchase_date                               AS purchase_date,
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

-- Re-asserted rather than assumed: CREATE OR REPLACE VIEW is not documented to
-- preserve reloptions, and losing security_invoker would make the view bypass
-- every RLS policy (integration/tenant-isolation.integration.test.ts asserts it).
ALTER VIEW v_purchase_summary SET (security_invoker = on);
