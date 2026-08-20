-- Back-dated orders — recording a sale that happened before it was typed in.
--
-- Everything in this app dates a sale by when the till saw it: `orders.opened_at`
-- and `closed_at` default to `now()`, and every day-bucketed report reads
-- `app_business_date(o.closed_at, …)` off them. That is right for a sale rung up
-- as it happens and wrong for the two cases a real café hits anyway — the day the
-- POS was down and the bills were written on paper, and the week of trading that
-- happened before this system was installed at all.
--
-- The fix is not a second kind of sale. A back-dated order is an ordinary
-- `orders` row whose `opened_at`/`closed_at` are the instant it actually
-- happened, whose stock consumption carries that same `occurred_at`, and whose
-- journal entries carry that day's `entry_date`. Reports, the ledger, COGS,
-- stock costing and the business-day bucketing therefore need no special case:
-- they were already reading those columns.
--
-- What this table adds is the part the `orders` row cannot say — that the row was
-- typed in later, by whom, and why. That matters for two reasons:
--
--   * an auditor asking "when was this entered?" gets an answer that is not
--     `opened_at`, which now deliberately lies about the wall clock; and
--   * a sale entered days late is exactly the shape of a sale invented days
--     late, so the reason and the actor are recorded next to it rather than
--     being reconstructible only from the audit log.
--
-- The fiscal-period lock (migration 0024) needs no change here: it fires on
-- `journal_entries.entry_date`, which is the back-dated day, so a locked or
-- soft-closed month refuses the entry rather than quietly absorbing it.

CREATE TABLE backdated_orders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    -- One row per order: an order is either back-dated at creation or it is not.
    -- Correcting one afterwards is `order_amendments`' job, not a second row here.
    order_id      uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    -- When the sale happened — the same instant written to orders.opened_at /
    -- closed_at and to the stock movements' occurred_at.
    occurred_at   timestamptz NOT NULL,
    -- The branch's business date for that instant (app_business_date, migration
    -- 0076), i.e. the day the ledger entries were posted on. Stored rather than
    -- recomputed so that changing a branch's business-day start later cannot
    -- retroactively disagree with the entries that were actually posted.
    entry_date    date NOT NULL,
    -- Why it is being entered late. Required — see the table comment.
    reason        text NOT NULL CHECK (btrim(reason) <> ''),
    -- When it was actually typed in, and by whom.
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backdated_orders_location_occurred
    ON backdated_orders (location_id, occurred_at DESC);

ALTER TABLE backdated_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE backdated_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON backdated_orders FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
