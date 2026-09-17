-- Fiscal-period integrity hardening.
--
-- The fiscal-year UI only creates canonical Jalali months, but these records
-- are financial controls and need their invariants in the database as well:
-- a period must belong to a year in the same business, stay inside that year's
-- range, never overlap another period of that business, and no writer may
-- reopen a period after the year-end closing entry has finalized the year.
--
-- The original period-lock trigger covered INSERT only. Retiming an existing
-- entry into a locked period is just as much a posting into that period, so
-- recreate it for the relevant UPDATE columns too.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A composite parent key makes the fiscal_periods business_id/fiscal_year_id
-- relationship enforceable by a foreign key rather than trusting every writer
-- to copy the correct tenant id.
ALTER TABLE fiscal_years
    ADD CONSTRAINT fiscal_years_id_business_id_key UNIQUE (id, business_id);

ALTER TABLE fiscal_periods
    ADD CONSTRAINT fiscal_periods_fiscal_year_business_id_fkey
    FOREIGN KEY (fiscal_year_id, business_id)
    REFERENCES fiscal_years (id, business_id)
    ON DELETE CASCADE;

-- daterange's [ ] bounds make both start and end dates inclusive, matching
-- enforce_fiscal_period_lock's BETWEEN predicate. Adjacent Jalali months are
-- still allowed because one ends the day before the next begins.
ALTER TABLE fiscal_periods
    ADD CONSTRAINT fiscal_periods_no_overlapping_ranges
    EXCLUDE USING gist (
        business_id WITH =,
        daterange(starts_on, ends_on, '[]') WITH &&
    );

CREATE OR REPLACE FUNCTION enforce_fiscal_period_parent_bounds() RETURNS trigger AS $$
DECLARE
    year_starts_on date;
    year_ends_on date;
BEGIN
    SELECT starts_on, ends_on
      INTO year_starts_on, year_ends_on
      FROM fiscal_years
     WHERE id = NEW.fiscal_year_id
       AND business_id = NEW.business_id;

    IF year_starts_on IS NULL THEN
        RAISE EXCEPTION 'fiscal_year_not_found' USING ERRCODE = 'P0001';
    END IF;

    IF NEW.starts_on < year_starts_on OR NEW.ends_on > year_ends_on THEN
        RAISE EXCEPTION 'fiscal_period_outside_year' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_fiscal_period_parent_bounds
    BEFORE INSERT OR UPDATE OF fiscal_year_id, business_id, starts_on, ends_on
    ON fiscal_periods
    FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_period_parent_bounds();

-- Once a year is finalized, its locked periods are part of the audit trail.
-- Defend that trail against every direct SQL mutation, including removing a
-- period or moving it to/from another year; application transitions separately
-- return the friendlier `fiscal_year_closed` error before they attempt a write.
CREATE OR REPLACE FUNCTION prevent_closed_fiscal_year_period_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1 FROM fiscal_years
             WHERE id = OLD.fiscal_year_id
               AND business_id = OLD.business_id
               AND closed_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'fiscal_year_closed' USING ERRCODE = 'P0001';
        END IF;
        RETURN OLD;
    END IF;

    IF EXISTS (
        SELECT 1 FROM fiscal_years
         WHERE id = NEW.fiscal_year_id
           AND business_id = NEW.business_id
           AND closed_at IS NOT NULL
    ) OR (
        TG_OP = 'UPDATE' AND EXISTS (
            SELECT 1 FROM fiscal_years
             WHERE id = OLD.fiscal_year_id
               AND business_id = OLD.business_id
               AND closed_at IS NOT NULL
        )
    ) THEN
        RAISE EXCEPTION 'fiscal_year_closed' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_closed_fiscal_year_period_change
    BEFORE INSERT OR UPDATE OR DELETE ON fiscal_periods
    FOR EACH ROW EXECUTE FUNCTION prevent_closed_fiscal_year_period_change();

DROP TRIGGER trg_enforce_fiscal_period_lock ON journal_entries;
CREATE TRIGGER trg_enforce_fiscal_period_lock
    BEFORE INSERT OR UPDATE OF business_id, entry_date, created_by ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION enforce_fiscal_period_lock();
