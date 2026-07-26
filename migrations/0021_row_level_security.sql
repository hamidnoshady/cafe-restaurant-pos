-- ============================================================================
-- 0021_row_level_security.sql — Phase 12: tenant isolation enforced by Postgres
--
-- Every tenant-scoped table gets a policy keyed on the `app.business_id`
-- session setting, which src/lib/db.ts sets from the caller's session before
-- running their statement. Isolation stops being a property of 99 correctly
-- written route handlers and becomes a property of the database.
--
-- Fail-closed by construction: current_setting('app.business_id', true)
-- returns NULL when unset, and every policy predicate is then false, so an
-- unscoped connection sees ZERO tenant rows rather than all of them.
--
-- IMPORTANT — the app's database role must not be a superuser and must not
-- have BYPASSRLS, or every policy below is a silent no-op. Superusers bypass
-- RLS unconditionally; FORCE ROW LEVEL SECURITY only covers the table *owner*.
-- `npm run db:app-role` provisions the correct role, and assertRlsEffective()
-- in src/lib/db.ts refuses to start a production server without it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Context helpers
-- ---------------------------------------------------------------------------

-- The tenant this connection is currently acting for; NULL when unscoped.
CREATE OR REPLACE FUNCTION app_current_business() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;

-- The documented escape hatch, set only by withoutTenantScope() in
-- src/lib/db.ts. Two operations legitimately cross tenants: resolving a login
-- email to its memberships (which necessarily happens before a business is
-- chosen), and platform administration. Grep for `app.rls_bypass` to audit
-- every place isolation is deliberately stood down.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT coalesce(current_setting('app.rls_bypass', true), '') = 'on' $$;

-- ---------------------------------------------------------------------------
-- Shape 1 — tables carrying business_id directly
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'accounts', 'audit_log', 'backup_runs', 'business_features', 'customer_returns',
        'customers', 'dashboard_widgets', 'inventory_cutovers', 'inventory_events',
        'inventory_negative_layers', 'inventory_transfers', 'inventory_write_downs',
        'journal_entries', 'locations', 'rollup_locations', 'saved_reports',
        'server_sync_log', 'settings', 'supplier_returns', 'users'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I FOR ALL
                USING (app_rls_bypass() OR business_id = app_current_business())
                WITH CHECK (app_rls_bypass() OR business_id = app_current_business())
        $f$, t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Shape 2 — tables scoped by location_id
-- ---------------------------------------------------------------------------
-- The IN (SELECT …) form is deliberate: the planner hashes it into a single
-- subplan per statement, where a per-row helper function would be evaluated
-- once per row on the hot order/inventory paths.
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'couriers', 'deliveries', 'devices', 'dining_tables', 'floor_sections',
        'inventory_history_coverage', 'inventory_items', 'inventory_lots',
        'menu_categories', 'menu_items', 'modifier_groups', 'modifiers',
        'order_items', 'order_number_counters', 'orders', 'payments', 'printers',
        'purchases', 'reservations', 'stock_counts', 'stock_movements',
        'suppliers', 'sync_events', 'table_sessions'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I FOR ALL
                USING (app_rls_bypass() OR location_id IN (
                    SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
                WITH CHECK (app_rls_bypass() OR location_id IN (
                    SELECT l.id FROM locations l WHERE l.business_id = app_current_business()))
        $f$, t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Shape 3 — child tables reachable only through a parent
-- ---------------------------------------------------------------------------
-- Each policy walks to the nearest ancestor that carries business_id or
-- location_id. Every anchor FK used below is NOT NULL, so there is no
-- "orphan row with a NULL parent" hole. The parent's own policy also applies
-- when it is referenced here, which makes these belt-and-braces rather than
-- the sole line of defence.

CREATE OR REPLACE FUNCTION app_owns_location(loc uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$ SELECT EXISTS (
        SELECT 1 FROM locations l WHERE l.id = loc AND l.business_id = app_current_business()
    ) $$;

-- journal_lines → journal_entries (business_id)
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON journal_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM journal_entries e
         WHERE e.id = journal_lines.entry_id AND e.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM journal_entries e
         WHERE e.id = journal_lines.entry_id AND e.business_id = app_current_business()));

-- customer_return_lines → customer_returns (business_id)
ALTER TABLE customer_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_return_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM customer_returns r
         WHERE r.id = customer_return_lines.customer_return_id
           AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM customer_returns r
         WHERE r.id = customer_return_lines.customer_return_id
           AND r.business_id = app_current_business()));

-- customer_return_inventory_allocations → customer_return_lines → customer_returns
ALTER TABLE customer_return_inventory_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_return_inventory_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_return_inventory_allocations FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM customer_return_lines cl
          JOIN customer_returns r ON r.id = cl.customer_return_id
         WHERE cl.id = customer_return_inventory_allocations.customer_return_line_id
           AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM customer_return_lines cl
          JOIN customer_returns r ON r.id = cl.customer_return_id
         WHERE cl.id = customer_return_inventory_allocations.customer_return_line_id
           AND r.business_id = app_current_business()));

-- supplier_return_lines → supplier_returns (business_id)
ALTER TABLE supplier_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supplier_return_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM supplier_returns r
         WHERE r.id = supplier_return_lines.supplier_return_id
           AND r.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM supplier_returns r
         WHERE r.id = supplier_return_lines.supplier_return_id
           AND r.business_id = app_current_business()));

-- inventory_cutover_lines → inventory_cutovers (business_id)
ALTER TABLE inventory_cutover_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cutover_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_cutover_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_cutovers c
         WHERE c.id = inventory_cutover_lines.cutover_id
           AND c.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_cutovers c
         WHERE c.id = inventory_cutover_lines.cutover_id
           AND c.business_id = app_current_business()));

-- inventory_write_down_lines → inventory_write_downs (business_id)
ALTER TABLE inventory_write_down_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_write_down_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_write_down_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_write_downs w
         WHERE w.id = inventory_write_down_lines.write_down_id
           AND w.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_write_downs w
         WHERE w.id = inventory_write_down_lines.write_down_id
           AND w.business_id = app_current_business()));

-- inventory_negative_layer_settlements → inventory_negative_layers (business_id)
ALTER TABLE inventory_negative_layer_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_negative_layer_settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_negative_layer_settlements FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_negative_layers nl
         WHERE nl.id = inventory_negative_layer_settlements.negative_layer_id
           AND nl.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_negative_layers nl
         WHERE nl.id = inventory_negative_layer_settlements.negative_layer_id
           AND nl.business_id = app_current_business()));

-- purchase_receipt_cost_allocations → inventory_events (business_id)
ALTER TABLE purchase_receipt_cost_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_receipt_cost_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_receipt_cost_allocations FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_events e
         WHERE e.id = purchase_receipt_cost_allocations.inventory_event_id
           AND e.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_events e
         WHERE e.id = purchase_receipt_cost_allocations.inventory_event_id
           AND e.business_id = app_current_business()));

-- inventory_transfer_lines → inventory_transfers (business_id)
ALTER TABLE inventory_transfer_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_transfer_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_transfers t
         WHERE t.id = inventory_transfer_lines.transfer_id
           AND t.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_transfers t
         WHERE t.id = inventory_transfer_lines.transfer_id
           AND t.business_id = app_current_business()));

-- inventory_transfer_allocations → inventory_transfer_lines → inventory_transfers
ALTER TABLE inventory_transfer_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transfer_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inventory_transfer_allocations FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_transfer_lines tl
          JOIN inventory_transfers t ON t.id = tl.transfer_id
         WHERE tl.id = inventory_transfer_allocations.transfer_line_id
           AND t.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM inventory_transfer_lines tl
          JOIN inventory_transfers t ON t.id = tl.transfer_id
         WHERE tl.id = inventory_transfer_allocations.transfer_line_id
           AND t.business_id = app_current_business()));

-- rollup_daily_summary → rollup_locations (business_id)
ALTER TABLE rollup_daily_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollup_daily_summary FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rollup_daily_summary FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM rollup_locations rl
         WHERE rl.id = rollup_daily_summary.rollup_location_id
           AND rl.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM rollup_locations rl
         WHERE rl.id = rollup_daily_summary.rollup_location_id
           AND rl.business_id = app_current_business()));

-- rollup_daily_staff → rollup_locations (business_id)
ALTER TABLE rollup_daily_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE rollup_daily_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rollup_daily_staff FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM rollup_locations rl
         WHERE rl.id = rollup_daily_staff.rollup_location_id
           AND rl.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM rollup_locations rl
         WHERE rl.id = rollup_daily_staff.rollup_location_id
           AND rl.business_id = app_current_business()));

-- menu_item_ingredients → menu_items (location_id)
ALTER TABLE menu_item_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_ingredients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_ingredients FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM menu_items mi
         WHERE mi.id = menu_item_ingredients.menu_item_id AND app_owns_location(mi.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM menu_items mi
         WHERE mi.id = menu_item_ingredients.menu_item_id AND app_owns_location(mi.location_id)));

-- menu_item_modifier_groups → menu_items (location_id)
ALTER TABLE menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_modifier_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_item_modifier_groups FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM menu_items mi
         WHERE mi.id = menu_item_modifier_groups.menu_item_id AND app_owns_location(mi.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM menu_items mi
         WHERE mi.id = menu_item_modifier_groups.menu_item_id AND app_owns_location(mi.location_id)));

-- modifier_ingredients → modifiers (location_id)
ALTER TABLE modifier_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE modifier_ingredients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON modifier_ingredients FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM modifiers m
         WHERE m.id = modifier_ingredients.modifier_id AND app_owns_location(m.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM modifiers m
         WHERE m.id = modifier_ingredients.modifier_id AND app_owns_location(m.location_id)));

-- order_item_modifiers → order_items (location_id)
ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_modifiers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_item_modifiers FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM order_items oi
         WHERE oi.id = order_item_modifiers.order_item_id AND app_owns_location(oi.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM order_items oi
         WHERE oi.id = order_item_modifiers.order_item_id AND app_owns_location(oi.location_id)));

-- order_item_inventory_snapshots → order_items (location_id)
ALTER TABLE order_item_inventory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_inventory_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_item_inventory_snapshots FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM order_items oi
         WHERE oi.id = order_item_inventory_snapshots.order_item_id
           AND app_owns_location(oi.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM order_items oi
         WHERE oi.id = order_item_inventory_snapshots.order_item_id
           AND app_owns_location(oi.location_id)));

-- purchase_items → purchases (location_id)
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_items FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM purchases p
         WHERE p.id = purchase_items.purchase_id AND app_owns_location(p.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM purchases p
         WHERE p.id = purchase_items.purchase_id AND app_owns_location(p.location_id)));

-- stock_count_lines → stock_counts (location_id)
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_count_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_count_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM stock_counts sc
         WHERE sc.id = stock_count_lines.stock_count_id AND app_owns_location(sc.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM stock_counts sc
         WHERE sc.id = stock_count_lines.stock_count_id AND app_owns_location(sc.location_id)));

-- table_session_tables → table_sessions (location_id)
ALTER TABLE table_session_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_session_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON table_session_tables FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM table_sessions ts
         WHERE ts.id = table_session_tables.session_id AND app_owns_location(ts.location_id)))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM table_sessions ts
         WHERE ts.id = table_session_tables.session_id AND app_owns_location(ts.location_id)));

-- ---------------------------------------------------------------------------
-- Shape 4 — the tenant root and the identity tables
-- ---------------------------------------------------------------------------

-- A business can only ever see itself. Creating one (signup, or Phase 15
-- provisioning) goes through withoutTenantScope().
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses FOR ALL
    USING (app_rls_bypass() OR id = app_current_business())
    WITH CHECK (app_rls_bypass() OR id = app_current_business());

-- Inside a tenant context you may only see login identities that are actually
-- members of your business — so a business can list its own team without ever
-- being able to enumerate the platform's users. Login itself resolves an email
-- across businesses and therefore runs bypassed.
ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_users FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM users u
         WHERE u.platform_user_id = platform_users.id
           AND u.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass());

-- user_locations → users (business_id)
ALTER TABLE user_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_locations FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM users u
         WHERE u.id = user_locations.user_id AND u.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM users u
         WHERE u.id = user_locations.user_id AND u.business_id = app_current_business()));

-- Deliberately NOT RLS-protected, and each for a reason:
--   feature_flags      — a global catalogue of definitions, no tenant data.
--                        Per-business state lives in business_features, which is.
--   platform_admins    — the super-user realm; only ever read through the
--   platform_audit_log   platform session, which is bypassed by design. A
--                        tenant-scoped connection has no route that touches them.
--   schema_migrations  — infrastructure.

-- ---------------------------------------------------------------------------
-- Reporting views follow the caller, not the view owner
-- ---------------------------------------------------------------------------
-- Without security_invoker a view runs with its owner's rights, which would
-- quietly re-open every tenant boundary the policies above just closed.
DO $$
DECLARE v text;
BEGIN
    FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'v\_%' LOOP
        EXECUTE format('ALTER VIEW %I SET (security_invoker = on)', v);
    END LOOP;
END $$;
