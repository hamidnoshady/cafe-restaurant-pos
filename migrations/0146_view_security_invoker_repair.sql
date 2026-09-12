-- ============================================================================
-- 0146_view_security_invoker_repair.sql — بازگرداندن security_invoker به ویوها
--
-- Repairs a tenant-isolation hole opened by 0144.
--
-- WHAT BROKE
--   Migration 0021 closed every tenant boundary with row-level security, and
--   because a view normally runs with its *owner's* rights — which would walk
--   straight through those policies — it also looped over every `v_%` view and
--   set `security_invoker = on` so a view follows the *caller* instead.
--   Migrations 0061/0062/0063/0065/0076/0090/0119 each re-asserted the option
--   on the views they touched, and 0065 spelled out why in a comment:
--
--       CREATE OR REPLACE VIEW is not documented to preserve reloptions.
--
--   It does not preserve them. `CREATE OR REPLACE VIEW` resets `pg_class.
--   reloptions` to NULL, silently dropping `security_invoker`. Migration 0144
--   rewrote `v_inventory_valuation` with CREATE OR REPLACE (to let a lot-based
--   business be 'lifo' as well as 'fifo') and was the one such migration that
--   did not re-assert the option afterwards. From 0144 onward the view reverted
--   to running as its owner.
--
-- WHY IT MATTERS
--   The owner is the migration/superuser role, for which RLS is not enforced,
--   so `v_inventory_valuation` returned **every business's** inventory to any
--   caller regardless of the `app.business_id` tenant context — item names,
--   quantities and Rial valuations. The leak reached the dependent view
--   `v_inventory_nrv_valuation` as well (it reads through the broken view, so
--   its own correct `security_invoker` could not save it), and with it the
--   API routes and AI tools that read those views: inventory stock levels,
--   warehouse stock values, and inventory valuation reporting.
--
-- THE REPAIR
--   The blanket loop from 0021, run once more. Forward-only migrations are
--   immutable once applied — 0144 has shipped, so it cannot be edited — and a
--   new migration is also what repairs databases that already ran 0144 rather
--   than only fresh ones. Re-asserting across *all* `v_%` views (instead of
--   naming the one view) keeps this a single self-healing statement: any view
--   that has drifted for the same reason is corrected here too.
--
--   Idempotent and cheap: `ALTER VIEW ... SET` on a view that already has the
--   option is a no-op catalog write, so re-running changes nothing.
--
--   Regression cover is two-layered:
--     * integration/tenant-isolation.integration.test.ts asserts the option on
--       every `v_%` view in the live schema, and now also proves the isolation
--       behaviourally through the view as an unprivileged role;
--     * src/lib/migration-view-security.test.ts reads the migration files and
--       fails any *new* migration that creates or replaces a view without
--       re-asserting the option — catching the next 0144 before it ever
--       reaches a database.
-- ============================================================================

DO $$
DECLARE v text;
BEGIN
    FOR v IN SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'v\_%' LOOP
        EXECUTE format('ALTER VIEW %I SET (security_invoker = on)', v);
    END LOOP;
END $$;
