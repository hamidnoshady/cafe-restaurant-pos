-- Server-side historical report filters page by branch/open time and commonly narrow by customer.
-- The location/opened index already exists (0001), and the location/order-number unique index already
-- serves exact order-number searches; only the missing customer and shift-history access paths are added.
CREATE INDEX IF NOT EXISTS idx_orders_location_customer_opened
    ON orders (location_id, customer_id, opened_at DESC)
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employee_shifts_location_started
    ON employee_shifts (location_id, started_at DESC, id DESC);
