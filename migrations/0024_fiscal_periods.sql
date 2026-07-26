-- Phase 16 — fiscal years & periods.
--
-- The foundation the rest of the accounting suite builds on: a fiscal year
-- (decision: the Jalali year, فروردین–اسفند, no configurable start month for
-- now) is divided into twelve periods, one per Jalali month. A period can be
-- soft-closed (only the owner or an accountant may still post into it — the
-- resolved open question "who may post to a closed-but-not-locked period")
-- or locked (nobody may, no exceptions).
--
-- The lock is enforced by a trigger on journal_entries rather than trusted at
-- the app layer, so it rejects every posting path without exception —
-- including the automatic ones (order payment, purchase receipt, waste,
-- inventory adjustment) that all funnel through postJournalEntry() — matching
-- this repo's convention of proving isolation at the database rather than
-- assuming callers behave (see migration 0021's RLS policies).

CREATE TYPE fiscal_period_status AS ENUM ('open', 'soft_closed', 'locked');

CREATE TABLE fiscal_years (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    label       text NOT NULL,           -- e.g. '1404'
    starts_on   date NOT NULL,
    ends_on     date NOT NULL,
    closed_at   timestamptz,             -- year-end closing entry posted (later PR)
    closed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, label),
    CONSTRAINT fiscal_years_dates_ordered CHECK (ends_on > starts_on)
);

CREATE TABLE fiscal_periods (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id) ON DELETE CASCADE,
    label          text NOT NULL,        -- e.g. '1404-01'
    starts_on      date NOT NULL,
    ends_on        date NOT NULL,
    status         fiscal_period_status NOT NULL DEFAULT 'open',
    soft_closed_at timestamptz,
    soft_closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
    locked_at      timestamptz,
    locked_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    reopened_at    timestamptz,
    reopened_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, starts_on),
    CONSTRAINT fiscal_periods_dates_ordered CHECK (ends_on > starts_on)
);
CREATE INDEX idx_fiscal_periods_business_range ON fiscal_periods (business_id, starts_on, ends_on);
CREATE INDEX idx_fiscal_periods_year ON fiscal_periods (fiscal_year_id);

ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_years FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_years FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_periods FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Period-lock enforcement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_fiscal_period_lock() RETURNS trigger AS $$
DECLARE
    period_status fiscal_period_status;
    actor_role    text;
BEGIN
    SELECT status INTO period_status
      FROM fiscal_periods
     WHERE business_id = NEW.business_id
       AND NEW.entry_date BETWEEN starts_on AND ends_on
     LIMIT 1;

    -- No period defined for this date (not yet set up for this business, or
    -- predates its Phase 16 adoption) — unaffected.
    IF period_status IS NULL OR period_status = 'open' THEN
        RETURN NEW;
    END IF;

    IF period_status = 'locked' THEN
        RAISE EXCEPTION 'fiscal_period_locked' USING ERRCODE = 'P0001';
    END IF;

    -- soft_closed: only the owner or an accountant may still post.
    IF NEW.created_by IS NULL THEN
        RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;

    SELECT role::text INTO actor_role FROM users WHERE id = NEW.created_by;
    IF actor_role IS NULL OR actor_role NOT IN ('owner', 'accountant') THEN
        RAISE EXCEPTION 'fiscal_period_soft_closed' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_fiscal_period_lock
    BEFORE INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_period_lock();
