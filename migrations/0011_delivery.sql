-- ============================================================================
-- 0011_delivery.sql — Phase 11 (Delivery, post-v1)
--
-- The delivery tables (couriers, deliveries) and the delivery_status /
-- 'delivery' order_type enums have existed since 0001_foundation — this
-- phase only *activates* them (UI + routes) and adds the two reporting
-- views that extend Phase 8's engine. No changes to the order/inventory/
-- ledger tables are needed: a delivery order pays, deducts stock, and posts
-- to the ledger through the exact same path as dine-in/takeaway (its flat
-- delivery fee rides on orders.service_charge, so it's already inside
-- orders.total that the payment + COGS entries are built from).
--
-- Both views follow the Phase 8 conventions: scoped by business_id via the
-- location join, business day bucketed in the location's own timezone, and
-- only completed orders count as delivered revenue.
-- ============================================================================

-- One row per delivery on a completed order: the courier, the fee, the
-- order revenue, and the door-to-customer time in minutes (null unless the
-- delivery was both dispatched and delivered, in the right order — mirrors
-- computeDeliveryMinutes in src/lib/delivery.ts).
CREATE VIEW v_delivery_performance AS
SELECT
    d.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date AS delivery_date,
    d.id                                        AS delivery_id,
    d.order_id,
    d.status                                    AS delivery_status,
    d.courier_id,
    c.name                                      AS courier_name,
    d.fee,
    o.total                                     AS revenue,
    CASE
        WHEN d.dispatched_at IS NOT NULL AND d.delivered_at IS NOT NULL
             AND d.delivered_at >= d.dispatched_at
        THEN round(extract(epoch FROM (d.delivered_at - d.dispatched_at)) / 60.0)
    END                                         AS delivery_minutes
FROM deliveries d
JOIN orders o ON o.id = d.order_id
JOIN locations l ON l.id = d.location_id
LEFT JOIN couriers c ON c.id = d.courier_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL;

-- One row per (courier, business day): how many deliveries they completed,
-- the average door-to-customer time, and the revenue they carried. Only
-- delivered deliveries on completed orders count toward a courier's tally.
CREATE VIEW v_courier_performance AS
SELECT
    d.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date AS delivery_date,
    d.courier_id,
    c.name                                      AS courier_name,
    count(*)                                    AS delivery_count,
    sum(o.total)                                AS revenue,
    sum(d.fee)                                  AS fees,
    round(avg(
        CASE
            WHEN d.dispatched_at IS NOT NULL AND d.delivered_at IS NOT NULL
                 AND d.delivered_at >= d.dispatched_at
            THEN extract(epoch FROM (d.delivered_at - d.dispatched_at)) / 60.0
        END
    ))                                          AS avg_delivery_minutes
FROM deliveries d
JOIN orders o ON o.id = d.order_id
JOIN locations l ON l.id = d.location_id
LEFT JOIN couriers c ON c.id = d.courier_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL
  AND d.status = 'delivered' AND d.courier_id IS NOT NULL
GROUP BY d.location_id, l.business_id, (o.closed_at AT TIME ZONE l.timezone)::date,
         d.courier_id, c.name;
