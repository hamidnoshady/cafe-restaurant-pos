-- Add-on (modifier) sales performance.
--
-- v_menu_item_performance (0008) already folds modifier price deltas into each
-- menu item's `revenue`, so add-on money was reportable only as part of the
-- item it was attached to — never on its own. This view exposes the same
-- deltas at the add-on grain: one row per add-on per menu item per business
-- day, so "which add-ons actually sell, and what do they earn" is answerable.
--
-- Grain and filters deliberately mirror v_menu_item_performance (completed
-- orders, non-voided lines, bucketed on closed_at in the branch's timezone)
-- so the two reports reconcile: summing revenue here equals the modifier
-- portion already inside v_menu_item_performance.revenue.
CREATE VIEW v_modifier_performance AS
SELECT
    o.location_id,
    l.business_id,
    (o.closed_at AT TIME ZONE l.timezone)::date        AS sale_date,
    oim.modifier_id,
    oim.name_snapshot                                  AS modifier_name,
    m.group_id                                         AS modifier_group_id,
    mg.name                                            AS modifier_group_name,
    oi.menu_item_id,
    oi.name_snapshot                                   AS item_name,
    -- an add-on row applies to the whole line, so it sells with the line's qty
    sum(oi.quantity)                                   AS quantity,
    sum(oim.price_delta * oi.quantity)                 AS revenue
FROM order_item_modifiers oim
JOIN order_items oi ON oi.id = oim.order_item_id
JOIN orders o ON o.id = oi.order_id
JOIN locations l ON l.id = o.location_id
LEFT JOIN modifiers m ON m.id = oim.modifier_id
LEFT JOIN modifier_groups mg ON mg.id = m.group_id
WHERE o.status = 'completed' AND o.closed_at IS NOT NULL AND oi.status != 'voided'
GROUP BY o.location_id, l.business_id, (o.closed_at AT TIME ZONE l.timezone)::date,
         oim.modifier_id, oim.name_snapshot, m.group_id, mg.name,
         oi.menu_item_id, oi.name_snapshot;

-- 0021's blanket loop already ran, so a view created after it has to opt in
-- explicitly or it runs with its owner's rights and bypasses every RLS policy
-- (integration/tenant-isolation.integration.test.ts asserts this).
ALTER VIEW v_modifier_performance SET (security_invoker = on);
