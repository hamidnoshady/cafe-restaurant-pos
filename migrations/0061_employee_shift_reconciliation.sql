-- ============================================================================
-- 0061_employee_shift_reconciliation.sql — per-shift reconciliation reporting
--
-- Phase 8's v_shift_reconciliation has always been a proxy: one row per
-- (location, business day, closing cashier), because when 0008 was written no
-- till-open/till-close entity existed. 0045 added the real one
-- (employee_shifts: started_at/ended_at/opening_float/closing_float), but
-- nothing in the reporting layer ever joined it — so the «تطبیق شیفت» report
-- could not show a shift's actual start and end times, only the calendar day
-- it fell on. This view reports the real entity: one row per shift, carrying
-- its own [started_at, ended_at] window and float counts.
--
-- Sales are attributed with exactly the rule shift-service.ts already applies
-- (orders.closed_by = the shift's employee, orders.closed_at inside the
-- shift's window) rather than by business_date, so an overnight shift that
-- crosses local midnight keeps its sales instead of splitting across two
-- rows. Like that code, it does not additionally constrain the order's
-- location: the shift's own location_id is what a report filters on.
--
-- v_shift_reconciliation is intentionally left in place and unchanged — it is
-- still the day-grain source for rollup-service.ts's daily cash/card/online
-- totals, which have no per-shift meaning.
-- ============================================================================

-- An open shift has ended_at IS NULL; its window runs to now(), so a shift in
-- progress still reconciles against the orders rung on it so far.
CREATE VIEW v_employee_shift_reconciliation AS
SELECT
    s.id                                        AS shift_id,
    s.business_id,
    s.location_id,
    s.business_date,
    s.started_at,
    s.ended_at,
    -- The report builder displays one column per dimension, so a shift's full
    -- window is emitted as a single "<startISO>~<endISO>" pair (empty after
    -- the '~' while the shift is still open). Kept as machine-readable UTC
    -- ISO-8601, not a formatted date: Jalali conversion is display-layer only
    -- (see src/lib/jalali.ts) and happens in report-ui.ts's formatDim.
    to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        || '~'
        || coalesce(to_char(s.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '')
                                                AS shift_window,
    s.employee_id,
    u.full_name                                 AS employee_name,
    s.opening_float,
    s.closing_float,
    round(
        extract(epoch FROM (coalesce(s.ended_at, now()) - s.started_at)) / 60.0
    )                                           AS duration_minutes,
    coalesce(sales.order_count, 0)              AS order_count,
    coalesce(sales.gross_total, 0)              AS gross_total,
    coalesce(sales.cash_total, 0)               AS cash_total,
    coalesce(sales.card_total, 0)               AS card_total,
    coalesce(sales.online_total, 0)             AS online_total,
    coalesce(sales.credit_total, 0)             AS credit_total,
    -- Counted drawer minus what it should hold (opening float + cash taken).
    -- NULL when the drawer wasn't counted — 0045 makes both float columns
    -- optional, and an uncounted drawer is not a zero variance. Mirrors
    -- shift.ts's reconcileCash, which callers skip for the same reason.
    CASE
        WHEN s.closing_float IS NULL THEN NULL
        ELSE s.closing_float - (coalesce(s.opening_float, 0) + coalesce(sales.cash_total, 0))
    END                                         AS cash_variance
FROM employee_shifts s
JOIN users u ON u.id = s.employee_id
LEFT JOIN LATERAL (
    -- Payments are summed in their own scalar subquery rather than joined
    -- alongside orders: a split-paid order has several payments rows, and
    -- joining them before summing o.total would multiply the order's gross
    -- by its payment count.
    SELECT
        count(*)                    AS order_count,
        coalesce(sum(o.total), 0)   AS gross_total,
        coalesce(sum(pay.cash), 0)  AS cash_total,
        coalesce(sum(pay.card), 0)  AS card_total,
        coalesce(sum(pay.online), 0) AS online_total,
        coalesce(sum(pay.credit), 0) AS credit_total
    FROM orders o
    LEFT JOIN LATERAL (
        SELECT
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'cash'), 0)   AS cash,
            coalesce(sum(p.amount) FILTER (WHERE p.method IN ('card', 'card_to_card')), 0) AS card,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'online'), 0) AS online,
            coalesce(sum(p.amount) FILTER (WHERE p.method = 'credit'), 0) AS credit
        FROM payments p
        WHERE p.order_id = o.id
    ) pay ON true
    WHERE o.closed_by = s.employee_id
      AND o.status = 'completed'
      AND o.closed_at IS NOT NULL
      AND o.closed_at >= s.started_at
      AND o.closed_at <= coalesce(s.ended_at, now())
) sales ON true;

-- 0021's blanket loop already ran, so a view created after it has to opt in
-- explicitly or it runs with its owner's rights and bypasses every RLS policy
-- (integration/tenant-isolation.integration.test.ts asserts this).
ALTER VIEW v_employee_shift_reconciliation SET (security_invoker = on);
