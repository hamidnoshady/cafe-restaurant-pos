-- Phase 29 — multiple customers on one busy table.
-- A table session can have several named guests. Their customer links are
-- separate from orders so the whole party can be split without changing the
-- order/payment model.

CREATE TABLE table_session_customers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    session_id  uuid NOT NULL REFERENCES table_sessions(id) ON DELETE CASCADE,
    guest_number integer NOT NULL CHECK (guest_number > 0),
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (session_id, guest_number),
    UNIQUE (session_id, customer_id)
);

CREATE INDEX idx_table_session_customers_session
    ON table_session_customers (session_id, guest_number);
CREATE INDEX idx_table_session_customers_customer
    ON table_session_customers (customer_id);

ALTER TABLE table_session_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_session_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON table_session_customers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
