-- ============================================================================
-- 0148_party_roles.sql — one person, several roles.
--
-- Migration 0137 made `parties` the one table for every counterparty and gave
-- it a single `role` column: customer, employee or supplier. That was already
-- the right table; what it could not say is the ordinary case a shop hits in
-- its first month — «این آقا هم مشتری ماست، هم از او جنس می‌خریم». The only
-- way to record it was a second row, which is a second accounting code, a
-- second balance and a second file for one human being.
--
-- So this migration adds the *set*, and keeps the scalar:
--
--   role   — the PRIMARY role. Unchanged in meaning, unchanged in every query
--            that already reads it: the accounting-code prefix scheme
--            (۱ مشتری / ۲ تأمین‌کننده / ۳ کارکنان), the employee_user_id link,
--            every report and every service. Nothing is rewritten.
--   roles  — every role this party holds, `role` included. Directory listings
--            and role filters read this one, so a person who is both shows up
--            under both words.
--
-- Deliberately NOT done here:
--
--   * No column is dropped or renamed. A forward migration that removed `role`
--     would touch eighty-odd queries across twelve services for no behavioural
--     gain — and `role` is genuinely still needed: an accounting code has one
--     prefix, so the record has to name which one.
--   * No row is deleted or merged. Two separate rows that happen to be the same
--     human stay two rows; merging them is the CRM's duplicates screen, which
--     already exists and already knows how to preserve balances.
--
-- The invariant `role = ANY(roles)` is enforced by a trigger rather than by
-- convention, because the writers are many (the party form, the POS quick-add,
-- the Holoo importer, the WooCommerce sync, the assistant's tools) and a writer
-- that knows nothing about `roles` must still leave a consistent row behind.
--
-- No new table, so no new RLS policy: `parties` already has tenant isolation
-- from 0137 and these columns live inside it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
ALTER TABLE parties
    ADD COLUMN roles text[] NOT NULL DEFAULT '{}'::text[];

-- Every value must be one of the three the API speaks, and the set must be
-- non-empty once the trigger has run. A CHECK over the array rather than a
-- lookup table for the same reason 0137 used a CHECK on `role`: the three roles
-- are a closed vocabulary the application ships, not data an owner adds.
ALTER TABLE parties
    ADD CONSTRAINT parties_roles_known
    CHECK (roles <@ ARRAY['customer', 'employee', 'supplier']::text[]);

-- ---------------------------------------------------------------------------
-- 2. Backfill — every existing party holds exactly the role it already had
-- ---------------------------------------------------------------------------
UPDATE parties SET roles = ARRAY[role]::text[] WHERE roles = '{}'::text[];

-- ---------------------------------------------------------------------------
-- 3. The invariant, as a trigger
--
-- Three cases, in the order they matter:
--   a. a writer that sent neither — keep what is stored (an UPDATE that names
--      other columns must not reset anybody's roles);
--   b. a writer that sent only `role` (every pre-0148 caller) — the set becomes
--      that role plus whatever it already held;
--   c. a writer that sent `roles` — it is authoritative, and `role` is folded
--      in so the primary role can never fall out of its own set.
-- ---------------------------------------------------------------------------
CREATE FUNCTION parties_sync_roles() RETURNS trigger AS $$
BEGIN
    IF NEW.roles IS NULL OR array_length(NEW.roles, 1) IS NULL THEN
        -- (a)/(b): nothing meaningful sent for the set.
        NEW.roles := ARRAY[NEW.role]::text[];
    ELSIF NOT (NEW.role = ANY (NEW.roles)) THEN
        -- (c): the primary role is always a member of the set.
        NEW.roles := array_append(NEW.roles, NEW.role);
    END IF;
    -- Stable order and no repeats, so two writers that sent the same set in a
    -- different order produce the same row (and `roles` compares by equality in
    -- tests and exports).
    SELECT array_agg(DISTINCT value ORDER BY value) INTO NEW.roles
      FROM unnest(NEW.roles) AS value;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_parties_sync_roles
    BEFORE INSERT OR UPDATE ON parties
    FOR EACH ROW EXECUTE FUNCTION parties_sync_roles();

-- ---------------------------------------------------------------------------
-- 4. The index the directory's role filter uses
--
-- GIN over the array: `roles && ARRAY['customer']` is the directory's whole
-- WHERE clause, and it replaces the `role = ANY(...)` btree lookups the
-- per-role screens used. The old `idx_parties_business_role` stays — the
-- accounting-code generator and the payroll queries still read the scalar.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_parties_roles ON parties USING gin (roles);
