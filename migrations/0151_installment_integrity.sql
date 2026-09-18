-- One credit invoice represents one receivable. Scheduling it twice would let
-- two plans settle the same A/R balance and drive the customer ledger negative.
-- Keep the invariant in PostgreSQL as well as in the service so concurrent
-- requests cannot bypass it.
CREATE UNIQUE INDEX idx_installments_invoice_plan
    ON installments (business_id, invoice_order_id)
    WHERE source = 'invoice' AND invoice_order_id IS NOT NULL;
