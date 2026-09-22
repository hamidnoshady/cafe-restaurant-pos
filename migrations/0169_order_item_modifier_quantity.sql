-- ---------------------------------------------------------------------------
-- Add-on quantity on the order line (order_item_modifiers.quantity).
-- ---------------------------------------------------------------------------
--
-- Until now a repeated add-on could only be expressed by submitting the same
-- modifier id several times — which every path rejects (duplicate_modifier,
-- migration 0165's UNIQUE(order_item_id, modifier_id)) — so «شات اضافه ×۳»
-- was impossible to sell, print, cost or consume correctly. The hospitality
-- model is a quantity per chosen add-on, on the one row the unique constraint
-- already guarantees exists:
--
--   order_item_modifiers.quantity  integer NOT NULL DEFAULT 1
--
-- * Forward-only and backward compatible: every existing row is, by the old
--   model's own rule, exactly one unit of its add-on, so the DEFAULT 1
--   backfill is not a guess — it is a restatement of what the data already
--   said.
-- * The UNIQUE(order_item_id, modifier_id) constraint stays: a repeated
--   add-on is still one row, now with quantity > 1. Ids are never repeated
--   in a request (duplicate_modifier keeps meaning what it meant).
-- * Pricing, receipt/kitchen rendering, reporting and inventory consumption
--   all read the quantity from this column; nothing fakes «×۳» in the UI.
--
-- The two reporting views that price an add-on row
-- (v_menu_item_performance, v_modifier_performance) are recreated so an
-- add-on's revenue counts its quantity: price_delta * oim.quantity * line qty.
-- ---------------------------------------------------------------------------

ALTER TABLE order_item_modifiers
    ADD COLUMN quantity integer NOT NULL DEFAULT 1;

ALTER TABLE order_item_modifiers
    ADD CONSTRAINT order_item_modifiers_quantity_positive CHECK (quantity >= 1);

-- ---------------------------------------------------------------------------
-- Reporting views: quantity-aware add-on revenue
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_menu_item_performance AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS sale_date,
    oi.menu_item_id,
    oi.name_snapshot                                    AS item_name,
    mi.category_id,
    mc.name                                             AS category_name,
    sum(oi.quantity)                                    AS quantity,
    sum(oi.quantity * oi.unit_price)
        + coalesce(sum(mods.modifier_total), 0)         AS revenue
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN locations l ON l.id = o.location_id
LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
LEFT JOIN menu_categories mc ON mc.id = mi.category_id
LEFT JOIN LATERAL (
    SELECT sum(oim.price_delta * oim.quantity * oi.quantity) AS modifier_total
    FROM order_item_modifiers oim
    WHERE oim.order_item_id = oi.id
) mods ON true
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL AND oi.status != 'voided'
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         oi.menu_item_id, oi.name_snapshot, mi.category_id, mc.name;

CREATE OR REPLACE VIEW v_modifier_performance AS
SELECT
    o.location_id,
    l.business_id,
    app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS sale_date,
    oim.modifier_id,
    oim.name_snapshot                                  AS modifier_name,
    m.group_id                                         AS modifier_group_id,
    mg.name                                            AS modifier_group_name,
    oi.menu_item_id,
    oi.name_snapshot                                   AS item_name,
    -- An add-on row applies to every unit of its line, `quantity` times over.
    sum(oi.quantity * oim.quantity)                    AS quantity,
    sum(oim.price_delta * oim.quantity * oi.quantity)  AS revenue
FROM order_item_modifiers oim
JOIN order_items oi ON oi.id = oim.order_item_id
JOIN orders o ON o.id = oi.order_id
JOIN locations l ON l.id = o.location_id
LEFT JOIN modifiers m ON m.id = oim.modifier_id
LEFT JOIN modifier_groups mg ON mg.id = m.group_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL AND oi.status != 'voided'
GROUP BY o.location_id, l.business_id,
         app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes),
         oim.modifier_id, oim.name_snapshot, m.group_id, mg.name,
         oi.menu_item_id, oi.name_snapshot;

-- CREATE OR REPLACE keeps a view's existing reloptions, but re-asserting
-- security_invoker (as 0076 did) makes the RLS guarantee local to this file
-- instead of something a reader has to confirm elsewhere.
ALTER VIEW v_menu_item_performance SET (security_invoker = on);
ALTER VIEW v_modifier_performance SET (security_invoker = on);
