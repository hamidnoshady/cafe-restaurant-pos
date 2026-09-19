-- 0153_retail_invoice_history.sql — keep invoice management fast as history grows.
--
-- The retail invoice screen filters by branch and reads newest invoice numbers
-- first. The existing general order indexes cannot use the partial retail
-- predicate as efficiently, especially once a branch has years of F&B orders.
CREATE INDEX IF NOT EXISTS idx_orders_retail_location_number
    ON orders (location_id, order_number DESC)
    WHERE type = 'retail' AND status IN ('completed', 'voided');

CREATE INDEX IF NOT EXISTS idx_orders_retail_location_customer
    ON orders (location_id, customer_id)
    WHERE type = 'retail' AND status IN ('completed', 'voided');
