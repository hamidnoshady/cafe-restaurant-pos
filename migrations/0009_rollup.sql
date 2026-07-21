-- ============================================================================
-- 0009_rollup.sql — Phase 9 (Multi-Location Rollup & Polish)
--
-- Central-side aggregation tables. A "central" server is just another
-- deployment of this same app: remote locations (each running their own
-- local server + DB) push pre-aggregated daily summaries here over HTTPS,
-- authenticated by a per-location bearer token (only its sha-256 hash is
-- stored — the plaintext is shown exactly once at registration).
--
-- The rollup tables deliberately do NOT reference `locations`: a remote
-- location exists in its own local database, not in the central one, so
-- its identity here is the registration row (`rollup_locations`) plus the
-- pushed `source_location_id` (its id in its own DB, informational only).
--
-- Day-level upsert keyed on (rollup_location_id, business_day) makes every
-- push idempotent: a location that was offline for a while simply re-pushes
-- its window and the days converge — no per-event queue or conflict
-- resolution needed for aggregates.
-- ============================================================================

CREATE TABLE rollup_locations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name               text NOT NULL,
    token_hash         text NOT NULL UNIQUE,        -- sha-256 hex of the bearer token
    source_location_id uuid,                        -- the location's id in its OWN local DB
    timezone           text,                        -- as reported by the location's last push
    last_synced_at     timestamptz,
    is_active          boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rollup_locations_business ON rollup_locations (business_id);

-- One row per (registered location, business day): the same sales/COGS/waste
-- shape the local reporting views produce, so central comparisons match what
-- each location sees on its own reports. Money in integer Rial, as always.
CREATE TABLE rollup_daily_summary (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rollup_location_id uuid NOT NULL REFERENCES rollup_locations(id) ON DELETE CASCADE,
    business_day       date NOT NULL,
    order_count        integer NOT NULL DEFAULT 0,
    subtotal           bigint NOT NULL DEFAULT 0,
    discount           bigint NOT NULL DEFAULT 0,
    service_charge     bigint NOT NULL DEFAULT 0,
    tax                bigint NOT NULL DEFAULT 0,
    total              bigint NOT NULL DEFAULT 0,
    cash_total         bigint NOT NULL DEFAULT 0,
    card_total         bigint NOT NULL DEFAULT 0,
    online_total       bigint NOT NULL DEFAULT 0,
    credit_total       bigint NOT NULL DEFAULT 0,
    cogs               bigint NOT NULL DEFAULT 0,
    waste_cost         bigint NOT NULL DEFAULT 0,
    synced_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (rollup_location_id, business_day)
);

-- One row per (registered location, business day, staff member): the staff
-- side of the cross-location comparison. source_staff_id is the user's id
-- in the location's own DB — stable across pushes, but not an FK here.
-- Rows for a day are replaced wholesale on re-push (a re-pushed day is the
-- new truth for that day, including staff who no longer appear on it).
CREATE TABLE rollup_daily_staff (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rollup_location_id uuid NOT NULL REFERENCES rollup_locations(id) ON DELETE CASCADE,
    business_day       date NOT NULL,
    source_staff_id    uuid NOT NULL,
    staff_name         text NOT NULL,
    role               text,
    order_count        integer NOT NULL DEFAULT 0,
    revenue            bigint NOT NULL DEFAULT 0,
    UNIQUE (rollup_location_id, business_day, source_staff_id)
);

-- ---------------------------------------------------------------------------
-- Performance pass (Phase 9): indexes for the Phase 8 reporting views.
-- Every day-bucketed sales view (v_sales_by_day, v_menu_item_performance,
-- v_shift_reconciliation, v_staff_performance) filters completed orders and
-- buckets on closed_at, but the only time index on orders was on opened_at.
-- v_waste_summary filters stock_movements by type; its existing index only
-- covers (location_id, occurred_at).
-- ---------------------------------------------------------------------------
CREATE INDEX idx_orders_location_closed ON orders (location_id, closed_at)
    WHERE status = 'completed' AND closed_at IS NOT NULL;
CREATE INDEX idx_stock_movements_location_type_time
    ON stock_movements (location_id, type, occurred_at);
