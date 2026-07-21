-- ============================================================================
-- 0008_reporting.sql — Phase 8 (Reporting & Analytics Engine)
--
--   * Reporting views: the ONLY thing the report builder / standard reports
--     are allowed to query (see src/lib/reports.ts's whitelist) — never raw
--     transactional tables directly, per the phase's exit criteria. Each
--     view already scopes to business_id/location_id and joins whatever it
--     needs, so the app layer only ever adds a WHERE + GROUP BY on top.
--   * Day-bucketed views use the location's own timezone
--     (`locations.timezone`, already stored since Phase 0) to decide which
--     business day a timestamptz falls on, not UTC midnight.
--   * saved_reports: a user's custom report definition (data source, metric,
--     dimension, filters) as JSON — see src/lib/reports.ts for the schema
--     that JSON must satisfy. is_standard rows seed the pre-built report
--     library so it's editable/copyable the same way a custom report is.
--   * dashboard_widgets: what's pinned to a dashboard grid and where.
--     Personal (user_id set) or a role's default (role set, user_id null) —
--     a user without a personal layout yet sees their role's default.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Reporting views
-- ---------------------------------------------------------------------------

-- One row per location per business day: order volume/revenue breakdown.
-- Only completed orders count as sales (voided/held orders never billed).
CREATE VIEW v_sales_by_day AS
SELECT
    o.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date AS sale_date,
    count(*)                                    AS order_count,
    sum(o.subtotal)                             AS subtotal,
    sum(o.discount)                              AS discount,
    sum(o.service_charge)                        AS service_charge,
    sum(o.tax)                                   AS tax,
    sum(o.total)                                 AS total
FROM orders o
JOIN locations l ON l.id = o.location_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id, (o.closed_at AT TIME ZONE l.timezone)::date;

-- One row per menu item per business day: quantity sold and revenue
-- (line price + modifier deltas), from completed orders' non-voided items.
CREATE VIEW v_menu_item_performance AS
SELECT
    o.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date        AS sale_date,
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
GROUP BY o.location_id, l.business_id, (o.closed_at AT TIME ZONE l.timezone)::date,
         oi.menu_item_id, oi.name_snapshot, mi.category_id, mc.name;

-- One row per inventory item: current on-hand quantity and its valuation.
-- Valuation uses remaining FIFO lots when any exist for the item (locked
-- costing method = 'fifo'), otherwise stock * avg_cost (weighted-average).
-- Snapshot view (no date dimension) — "as of now", like a physical count.
CREATE VIEW v_inventory_valuation AS
SELECT
    ii.location_id,
    l.business_id,
    ii.id                                   AS inventory_item_id,
    ii.name                                 AS item_name,
    ii.unit,
    coalesce(sm.stock_qty, 0)               AS stock_qty,
    ii.avg_cost,
    coalesce(lots.lot_value, coalesce(sm.stock_qty, 0) * ii.avg_cost) AS valuation
FROM inventory_items ii
JOIN locations l ON l.id = ii.location_id
LEFT JOIN (
    SELECT inventory_item_id, sum(quantity) AS stock_qty
    FROM stock_movements GROUP BY inventory_item_id
) sm ON sm.inventory_item_id = ii.id
LEFT JOIN (
    SELECT inventory_item_id, sum(remaining_qty * unit_cost) AS lot_value
    FROM inventory_lots WHERE remaining_qty > 0 GROUP BY inventory_item_id
) lots ON lots.inventory_item_id = ii.id
WHERE ii.is_active;

-- One row per journal line: the base for P&L, Balance Sheet, and any custom
-- ledger-shaped report. Granular (not pre-aggregated) so the report builder
-- can group by day/week/month/account/account type freely.
CREATE VIEW v_ledger_by_account AS
SELECT
    je.business_id,
    je.location_id,
    je.entry_date,
    a.id   AS account_id,
    a.code AS account_code,
    a.name AS account_name,
    a.type AS account_type,
    jl.debit,
    jl.credit
FROM journal_lines jl
JOIN journal_entries je ON je.id = jl.entry_id
JOIN accounts a ON a.id = jl.account_id;

-- One row per (location, business day, closing cashier): a proxy "shift" —
-- there's no till/clock-in entity in the schema yet (Phase 0-7 never built
-- one), so a shift is the set of orders one cashier closed on one business
-- day, reconciled by payment method. See Phase 8 doc, decision on shifts.
CREATE VIEW v_shift_reconciliation AS
SELECT
    o.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date AS business_date,
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
GROUP BY o.location_id, l.business_id, (o.closed_at AT TIME ZONE l.timezone)::date,
         o.closed_by, u.full_name;

-- One row per closed table session: how long the table was occupied and
-- what it billed (its orders, via orders.table_session_id).
CREATE VIEW v_table_turnover AS
SELECT
    ts.location_id,
    l.business_id,
    ts.id                                                        AS session_id,
    dt.id                                                        AS table_id,
    dt.name                                                      AS table_name,
    ts.opened_at,
    ts.closed_at,
    extract(epoch FROM (ts.closed_at - ts.opened_at)) / 60.0     AS duration_minutes,
    ts.party_size,
    coalesce(o.revenue, 0)                                       AS revenue
FROM table_sessions ts
JOIN locations l ON l.id = ts.location_id
LEFT JOIN dining_tables dt ON dt.id = ts.primary_table_id
LEFT JOIN LATERAL (
    SELECT sum(total) AS revenue FROM orders
    WHERE table_session_id = ts.id AND status = 'completed'
) o ON true
WHERE ts.status = 'closed' AND ts.closed_at IS NOT NULL;

-- One row per (staff member, business day): orders closed and revenue —
-- the cashier/waiter side of "staff performance" (whoever closed the sale).
CREATE VIEW v_staff_performance AS
SELECT
    o.location_id,
    l.business_id,
    o.closed_by                                 AS staff_id,
    u.full_name                                 AS staff_name,
    u.role,
    (o.closed_at AT TIME ZONE l.timezone)::date AS business_date,
    count(*)                                    AS order_count,
    sum(o.total)                                AS revenue,
    round(avg(o.total))                         AS avg_ticket
FROM orders o
JOIN locations l ON l.id = o.location_id
JOIN users u ON u.id = o.closed_by
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
GROUP BY o.location_id, l.business_id, o.closed_by, u.full_name, u.role,
         (o.closed_at AT TIME ZONE l.timezone)::date;

-- One row per (inventory item, business day, waste reason): quantity and
-- cost wasted. stock_movements.quantity is negative for waste; flipped
-- here so the report shows a positive wasted amount.
CREATE VIEW v_waste_summary AS
SELECT
    sm.location_id,
    l.business_id,
    (sm.occurred_at AT TIME ZONE l.timezone)::date AS waste_date,
    sm.inventory_item_id,
    ii.name                                        AS item_name,
    ii.unit,
    sm.waste_reason,
    sum(-sm.quantity)                              AS quantity,
    sum(-sm.quantity * coalesce(sm.unit_cost, 0))  AS cost
FROM stock_movements sm
JOIN locations l ON l.id = sm.location_id
JOIN inventory_items ii ON ii.id = sm.inventory_item_id
WHERE sm.type = 'waste'
GROUP BY sm.location_id, l.business_id, (sm.occurred_at AT TIME ZONE l.timezone)::date,
         sm.inventory_item_id, ii.name, ii.unit, sm.waste_reason;

-- ---------------------------------------------------------------------------
-- Saved reports & dashboard widgets
-- ---------------------------------------------------------------------------

-- A custom (or seeded standard) report definition. `config` shape is
-- validated in the app layer (src/lib/reports.ts: view/metric/dimension/
-- filters) — never raw SQL, so a saved report can only ever run against
-- the view whitelist above.
CREATE TABLE saved_reports (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    name        text NOT NULL,
    config      jsonb NOT NULL,
    is_standard boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_saved_reports_business ON saved_reports (business_id);

-- A widget pinned to a dashboard grid. Personal layout (user_id set) takes
-- precedence; a role's default (role set, user_id null) is what a user
-- without a personal layout yet sees — see getDashboardWidgets in
-- src/lib/reports-service.ts.
CREATE TABLE dashboard_widgets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
    role            user_role,
    saved_report_id uuid NOT NULL REFERENCES saved_reports(id) ON DELETE CASCADE,
    chart_type      text NOT NULL CHECK (chart_type IN ('line', 'bar', 'pie', 'number')),
    title           text,
    x               integer NOT NULL DEFAULT 0,
    y               integer NOT NULL DEFAULT 0,
    w               integer NOT NULL DEFAULT 4,
    h               integer NOT NULL DEFAULT 3,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dashboard_widgets_scope CHECK ((user_id IS NOT NULL) <> (role IS NOT NULL))
);
CREATE INDEX idx_dashboard_widgets_user ON dashboard_widgets (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_dashboard_widgets_role ON dashboard_widgets (business_id, role) WHERE role IS NOT NULL;
