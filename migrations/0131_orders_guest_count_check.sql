-- guest_count had no floor: a negative value (typo, or a request built by
-- hand rather than through the POS screen) was accepted silently and would
-- have thrown off any covers/guest-count report reading it. POST /api/orders
-- now rejects it at the API, but every other writer of this column (the
-- offline sync-events replay path, a future integration) shares this table,
-- so the constraint is the actual floor.
ALTER TABLE orders
  ADD CONSTRAINT orders_guest_count_check CHECK (guest_count IS NULL OR guest_count >= 0);
