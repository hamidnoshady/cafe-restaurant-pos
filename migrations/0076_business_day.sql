-- ============================================================================
-- 0076_business_day.sql — the business day (روز کاری), an optional per-branch
-- trading day that does not have to start at local midnight.
--
-- Every day bucket in the app has always been the branch's *calendar* day:
-- `(o.closed_at AT TIME ZONE l.timezone)::date`, everywhere from
-- v_sales_by_day (0008) to the dashboard's KPI query. That is right for a
-- shop that opens and closes inside one date, and wrong for the many that
-- do not: a café trading 18:00→03:00 has its single service cut in half at
-- midnight — the dashboard zeroes while the till is still open, the orders
-- screen starts a fresh list at 00:00, and the evening lands on two report
-- rows that neither total alone can explain.
--
-- The fix is one number per branch: `business_day_start_minutes`, the minutes
-- after local midnight at which its trading day begins. A branch that sets it
-- to 18:00 has business days running 18:00 → 18:00, so 18:00–03:00 is one day
-- with one date. NULL — the default, and what every existing branch keeps —
-- means the feature is off and the calendar day applies exactly as before:
-- `app_business_date(ts, tz, NULL)` is `(ts AT TIME ZONE tz)::date`, character
-- for character the expression it replaces. Nothing changes for a business
-- that does not opt in, which is the point: this is a setting management turns
-- on, not a new rule imposed on everyone.
--
-- The rule lives in `app_business_date` rather than being inlined into each
-- view, so the eight day-bucketed views below, the dashboard's live window and
-- `openShift`'s stored `business_date` cannot drift apart. It is a plain SQL
-- function, so the planner inlines it and the views plan as they did before.
--
-- `business_day_closures` is the manual half: "بستن روز کاری" — management
-- declaring the current business day finished early (the 03:00 cash-up, rather
-- than waiting for 18:00 to come round again). It moves the *live* window only
-- — the dashboard KPIs and the orders screen's closed list — and deliberately
-- not the reporting bucket: an order rung at 04:00 after a 03:00 close still
-- belongs to the business day it was sold in, so no sale can ever fall out of
-- a report by someone pressing a button. See src/lib/business-day.ts.
-- ============================================================================

-- Minutes after local midnight; NULL = no business day configured (calendar
-- day, the behaviour of every release before this one). 0 would mean the same
-- thing arithmetically, but is stored as a real choice: it is what a branch
-- that explicitly picked midnight looks like.
ALTER TABLE locations
    ADD COLUMN business_day_start_minutes integer,
    ADD CONSTRAINT locations_business_day_start_range
        CHECK (business_day_start_minutes IS NULL
               OR (business_day_start_minutes >= 0 AND business_day_start_minutes < 1440));

-- ---------------------------------------------------------------------------
-- The rule, in one place
-- ---------------------------------------------------------------------------

-- Which business day a timestamp falls on. Shifting the *local* wall clock
-- back by the start offset and then truncating is what makes an after-midnight
-- hour keep the previous date: with start = 18:00, 2026-08-17 01:00 local
-- becomes 2026-08-16 07:00, so its business date is 2026-08-16 — the same
-- date the 20:00 order before it got.
--
-- IMMUTABLE, not STABLE: `timestamptz AT TIME ZONE text` is itself immutable
-- in PostgreSQL, and the marking is what lets the planner inline this into the
-- views' GROUP BY instead of calling it per row.
CREATE FUNCTION app_business_date(ts timestamptz, tz text, start_minutes integer)
RETURNS date
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT ((ts AT TIME ZONE coalesce(tz, 'UTC'))
            - make_interval(mins => coalesce(start_minutes, 0)))::date
$$;

-- The instant a timestamp's own business day began: its business date read
-- back as a local wall-clock time at the configured start, converted to an
-- instant in the branch's zone. With start_minutes NULL this is local
-- midnight — what `date_trunc('day', now() AT TIME ZONE tz) AT TIME ZONE tz`
-- returned before.
CREATE FUNCTION app_business_day_start(ts timestamptz, tz text, start_minutes integer)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT ((app_business_date(ts, tz, start_minutes)
             + make_interval(mins => coalesce(start_minutes, 0)))
            AT TIME ZONE coalesce(tz, 'UTC'))
$$;

-- The instant it ends — i.e. when the next one begins. Computed from the next
-- business *date* rather than as `start + interval '1 day'`, which PostgreSQL
-- would resolve in the session's timezone, not the branch's.
CREATE FUNCTION app_business_day_end(ts timestamptz, tz text, start_minutes integer)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT ((app_business_date(ts, tz, start_minutes) + 1
             + make_interval(mins => coalesce(start_minutes, 0)))
            AT TIME ZONE coalesce(tz, 'UTC'))
$$;

-- ---------------------------------------------------------------------------
-- Manual "close the business day now"
-- ---------------------------------------------------------------------------
--
-- One row per time management ended a business day early. Only the newest row
-- for a branch is consulted, and only while it falls inside the business day
-- currently in progress — a close recorded at 03:00 stops counting the moment
-- 18:00 starts the next day on its own. The history is kept rather than
-- overwritten so «چه کسی، کِی روز را بست» is answerable from the same table
-- the window is derived from.
CREATE TABLE business_day_closures (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid NOT NULL,
    -- The business day that was closed, by the rule above — recorded at close
    -- time so a later change to the branch's start time cannot re-label it.
    business_date date NOT NULL,
    closed_at     timestamptz NOT NULL DEFAULT now(),
    closed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    note          text,
    CONSTRAINT business_day_closures_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE CASCADE
);
-- Every read is "the newest closure at this branch".
CREATE INDEX idx_business_day_closures_location
    ON business_day_closures (location_id, closed_at DESC);

ALTER TABLE business_day_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_day_closures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_day_closures FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Every day-bucketed reporting view, re-expressed against the rule
-- ---------------------------------------------------------------------------
--
-- Same columns, same types, same filters — only the date expression changes,
-- so `CREATE OR REPLACE` is enough and no saved report, dashboard widget or
-- rollup query needs touching. A branch that has not configured a business day
-- gets byte-identical results.
--
-- The purchase views (0063/0065) are deliberately left alone: a purchase
-- carries its own user-entered `purchase_date` and is not part of the trading
-- day the till works through.

CREATE OR REPLACE VIEW v_sales_by_day AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS sale_date,
    count(*)                                    AS order_count,
    sum(o.subtotal)                             AS subtotal,
    sum(o.discount)                              AS discount,
    sum(o.service_charge)                        AS service_charge,
    sum(o.tax)                                   AS tax,
    sum(o.total)                                 AS total
FROM orders o
JOIN locations l ON l.id = o.location_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes);

CREATE OR REPLACE VIEW v_menu_item_performance AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS sale_date,
    oi.menu_item_id,
    oi.name_snapshot                                    AS item_name,
    mi.category_id,
    mc.name                                             AS category_name,
    sum(oi.quantity)                                    AS quantity,
    sum(oi.quantity * oi.unit_price)
        + coalesce(sum(mods.modifier_total), 0)         AS revenue
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN locations l ON l.id = o.location_id
LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
LEFT JOIN menu_categories mc ON mc.id = mi.category_id
LEFT JOIN LATERAL (
    SELECT sum(oim.price_delta * oi.quantity) AS modifier_total
    FROM order_item_modifiers oim
    WHERE oim.order_item_id = oi.id
) mods ON true
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL AND oi.status != 'voided'
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         oi.menu_item_id, oi.name_snapshot, mi.category_id, mc.name;

CREATE OR REPLACE VIEW v_shift_reconciliation AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS business_date,
    o.closed_by,
    u.full_name                                 AS cashier_name,
    count(DISTINCT o.id)                        AS order_count,
    sum(o.total)                                AS gross_total,
    coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)         AS cash_total,
    coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card_total,
    coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0)       AS online_total,
    coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0)       AS credit_total
FROM orders o
JOIN locations l ON l.id = o.location_id
LEFT JOIN users u ON u.id = o.closed_by
LEFT JOIN payments p ON p.order_id = o.id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         o.closed_by, u.full_name;

CREATE OR REPLACE VIEW v_staff_performance AS
SELECT
    o.location_id,
    l.business_id,
    o.closed_by                                 AS staff_id,
    u.full_name                                 AS staff_name,
    u.role,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS business_date,
    count(*)                                    AS order_count,
    sum(o.total)                                AS revenue,
    round(avg(o.total))                         AS avg_ticket
FROM orders o
JOIN locations l ON l.id = o.location_id
JOIN users u ON u.id = o.closed_by
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id, o.closed_by, u.full_name, u.role,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes);

-- Waste is bucketed on when the stock left, so it follows the same trading day
-- as the sales it sits beside in a report. Column list is 0015's.
CREATE OR REPLACE VIEW v_waste_summary AS
SELECT sm.location_id, l.business_id,
       app_business_date(sm.occurred_at, l.timezone, l.business_day_start_minutes) AS waste_date,
       sm.inventory_item_id, ii.name AS item_name, ii.unit, sm.waste_reason,
       sum(-sm.quantity) AS quantity,
       sum(CASE WHEN sm.cost_value_rial IS NOT NULL THEN sm.cost_value_rial
                ELSE round(-sm.quantity * COALESCE(sm.unit_cost,0))::bigint END) AS cost
FROM stock_movements sm
JOIN locations l ON l.id=sm.location_id
JOIN inventory_items ii ON ii.id=sm.inventory_item_id
WHERE sm.type='waste'
GROUP BY sm.location_id,l.business_id,
         app_business_date(sm.occurred_at, l.timezone, l.business_day_start_minutes),
         sm.inventory_item_id,ii.name,ii.unit,sm.waste_reason;

CREATE OR REPLACE VIEW v_delivery_performance AS
SELECT
    d.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS delivery_date,
    d.id                                        AS delivery_id,
    d.order_id,
    d.status                                    AS delivery_status,
    d.courier_id,
    c.name                                      AS courier_name,
    d.fee,
    o.total                                     AS revenue,
    CASE
        WHEN d.dispatched_at IS NOT NULL AND d.delivered_at IS NOT NULL
             AND d.delivered_at >= d.dispatched_at
        THEN round(extract(epoch FROM (d.delivered_at - d.dispatched_at)) / 60.0)
    END                                         AS delivery_minutes
FROM deliveries d
JOIN orders o ON o.id = d.order_id
JOIN locations l ON l.id = d.location_id
LEFT JOIN couriers c ON c.id = d.courier_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL;

CREATE OR REPLACE VIEW v_courier_performance AS
SELECT
    d.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS delivery_date,
    d.courier_id,
    c.name                                      AS courier_name,
    count(*)                                    AS delivery_count,
    sum(o.total)                                AS revenue,
    sum(d.fee)                                  AS fees,
    round(avg(
        CASE
            WHEN d.dispatched_at IS NOT NULL AND d.delivered_at IS NOT NULL
                 AND d.delivered_at >= d.dispatched_at
            THEN extract(epoch FROM (d.delivered_at - d.dispatched_at)) / 60.0
        END
    ))                                          AS avg_delivery_minutes
FROM deliveries d
JOIN orders o ON o.id = d.order_id
JOIN locations l ON l.id = d.location_id
LEFT JOIN couriers c ON c.id = d.courier_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
  AND d.status = 'delivered' AND d.courier_id IS NOT NULL
GROUP BY d.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         d.courier_id, c.name;

CREATE OR REPLACE VIEW v_modifier_performance AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS sale_date,
    oim.modifier_id,
    oim.name_snapshot                                  AS modifier_name,
    m.group_id                                         AS modifier_group_id,
    mg.name                                            AS modifier_group_name,
    oi.menu_item_id,
    oi.name_snapshot                                   AS item_name,
    sum(oi.quantity)                                   AS quantity,
    sum(oim.price_delta * oi.quantity)                 AS revenue
FROM order_item_modifiers oim
JOIN order_items oi ON oi.id = oim.order_item_id
JOIN orders o ON o.id = oi.order_id
JOIN locations l ON l.id = o.location_id
LEFT JOIN modifiers m ON m.id = oim.modifier_id
LEFT JOIN modifier_groups mg ON mg.id = m.group_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL AND oi.status != 'voided'
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         oim.modifier_id, oim.name_snapshot, m.group_id, mg.name,
         oi.menu_item_id, oi.name_snapshot;

-- CREATE OR REPLACE keeps a view's existing reloptions, but 0021's blanket
-- loop is what set security_invoker on the older ones and it has already run —
-- re-asserting it here is cheap and makes the guarantee local to this file
-- rather than something a reader has to go and confirm elsewhere.
DO $$
DECLARE v text;
BEGIN
    FOR v IN SELECT unnest(ARRAY[
        'v_sales_by_day', 'v_menu_item_performance', 'v_shift_reconciliation',
        'v_staff_performance', 'v_waste_summary', 'v_delivery_performance',
        'v_courier_performance', 'v_modifier_performance'
    ]) LOOP
        EXECUTE format('ALTER VIEW %I SET (security_invoker = on)', v);
    END LOOP;
END $$;
