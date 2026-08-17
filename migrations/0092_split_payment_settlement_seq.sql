-- "One live *settlement* per order" — the split-payment form of 0014's guard.
--
-- Migration 0091 made a checkout able to write one `payments` row per tender
-- (۲۰۰٬۰۰۰ نقدی + ۳۰۰٬۰۰۰ کارت‌خوان). It did not touch
-- `uq_payments_one_positive_per_order`, which since 0014 has been a unique
-- index on `(order_id)` over the live positive rows — so the second slice of
-- every real split violates it and the whole checkout rolls back. 0091's own
-- tests exercise the tender arithmetic and the payment-ways CRUD, neither of
-- which writes two live rows against one order, which is why this got through.
--
-- The guarantee 0014 wanted is unchanged and still worth keeping: a concurrent
-- checkout must not be able to charge one bill twice. (0075 already restated it
-- once, narrowing the index to rows an amendment has not superseded.) What has
-- changed is that "a settlement" is no longer "a row" — it is now a *set* of
-- rows written by one checkout.
--
-- So number the rows within their settlement instead of forbidding the second
-- one. Each checkout stamps its slices 1..N, and the unique index moves to
-- `(order_id, settlement_seq)`. One checkout writing three slices is 1, 2, 3 —
-- fine. Two concurrent checkouts of the same bill both start at 1 and the
-- second is refused, which is exactly what the old index did. Every row written
-- before today is the sole slice of its own settlement, so the default of 1
-- backfills them correctly and no existing order can collide.
--
-- (The application-level guard is untouched and still the primary one:
-- `lockOpenOrder` takes the order's row lock before any payment is written, so
-- the second checkout sees 'completed' and gives up before it inserts anything.
-- This index is, as 0014 put it, the final guard against an omitted lock in a
-- future write path.)

ALTER TABLE payments
    ADD COLUMN settlement_seq integer NOT NULL DEFAULT 1
        CHECK (settlement_seq >= 1);

DROP INDEX uq_payments_one_positive_per_order;
CREATE UNIQUE INDEX uq_payments_one_positive_per_order
  ON payments (order_id, settlement_seq)
  WHERE amount > 0 AND superseded_by_amendment_id IS NULL;
