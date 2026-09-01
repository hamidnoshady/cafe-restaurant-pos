-- POST /api/orders has no idempotency protection today: a network retry (a
-- proxy timeout, a browser retry after a lost response) or two near-
-- simultaneous submissions for the same cart create two separate orders for
-- what the cashier believes was one submission. The offline queue already
-- solved this shape of problem for its own replay path with
-- sync_events.client_event_id; this gives the synchronous POST /api/orders
-- path the same tool, scoped per location the way order_number already is.
-- Most orders will still carry no client_request_id (an older/cached
-- frontend bundle, the offline-queue replay path, backdated intake), so the
-- uniqueness has to ignore NULLs rather than treat them as one shared value —
-- the same correction migration 0013 made to inventory_events' idempotency
-- key after 0012 first tried NULLS NOT DISTINCT on a column that is nullable
-- in practice.
ALTER TABLE orders ADD COLUMN client_request_id text;
CREATE UNIQUE INDEX uq_orders_location_client_request_id
  ON orders (location_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
