-- ============================================================================
-- 0165_restaurant_menu_integrity.sql — food-service menu/order integrity.
--
-- Five invariants this deployment could until now only hope for:
--
--   1. `modifier_groups.is_active` — a modifier group could only be removed
--      from sale by destructive DELETE (which cascades its modifiers away).
--      Groups now carry the same reversible lifecycle as items, categories
--      and modifiers: disable stops the group appearing in new-order
--      selection; order history keeps its own snapshots either way.
--
--   2. Per-item selection bounds on `menu_item_modifier_groups`
--      (min/max overrides + sort order + link lifecycle). One shared «نوع
--      شیر» group can now be required (1..1) on a latte and optional (0..1)
--      on an espresso without duplicating the group. Existing rows keep
--      NULL overrides → the group's defaults, so no behaviour changes.
--
--   3. `order_item_modifiers (order_item_id, modifier_id)` UNIQUE — a
--      duplicate add-on id on one line double-charges the guest while the
--      inventory snapshot (`ANY(uuid[])`) consumes its ingredients once.
--      The write paths now reject duplicates in the service layer before
--      persistence; this constraint is the race-proof backstop for any
--      future writer. Pre-existing duplicates (only writable by the old
--      double-submission bug — a line's add-ons were always replaced, never
--      appended) are collapsed to one row first: an exact duplicate is the
--      same submission written twice, and keeping one copy is what makes the
--      line agree with the inventory consumption that was recorded for it.
--      PostgreSQL's default NULLS DISTINCT semantics are exactly what
--      history needs on the other side: rows whose modifier was later
--      deleted (modifier_id NULL) never conflict with each other.
--
--   4. Unique names/SKUs where the application already pretends they are
--      unique: category name per location, menu-item SKU per location,
--      active modifier-group name per location, active modifier name within
--      a group. The code has always pre-checked these (or silently created
--      confusing duplicates — two «اسپرسو» with the same SKU both matching
--      the till's code search); the indexes close the check-then-insert
--      race two concurrent requests could win. Pre-existing duplicates are
--      resolved first by appending the row's own uuid prefix — unique by
--      construction, and honest about what happened.
--
--   5. Effective-bounds sanity for the new override columns (min >= 0,
--      max >= 1, min <= max within the same row). The cross-table rule
--      (item override resolved against the group's *default* max must stay
--      satisfiable) is enforced in the service layer, where the group's row
--      is in hand; a CHECK here could not see it.
--
-- No new tables, so no new RLS policies; every altered table keeps its
-- existing tenant_isolation policy and the location_id scoping it promises.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Modifier-group lifecycle (+ ordering parity with every other menu row)
-- ---------------------------------------------------------------------------
ALTER TABLE modifier_groups
    ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Per-item attachment configuration
-- ---------------------------------------------------------------------------
ALTER TABLE menu_item_modifier_groups
    ADD COLUMN IF NOT EXISTS min_select_override integer,
    ADD COLUMN IF NOT EXISTS max_select_override integer,
    ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE menu_item_modifier_groups DROP CONSTRAINT IF EXISTS mimg_override_bounds;
ALTER TABLE menu_item_modifier_groups
    ADD CONSTRAINT mimg_override_bounds CHECK (
        (min_select_override IS NULL OR min_select_override >= 0)
        AND (max_select_override IS NULL OR max_select_override >= 1)
        AND (min_select_override IS NULL OR max_select_override IS NULL
             OR min_select_override <= max_select_override)
    );

-- Ordering support for the per-item attachment list (POS picker, menu
-- manager, offline snapshots) without a sort scan per read.
CREATE INDEX IF NOT EXISTS idx_menu_item_modifier_groups_item_order
    ON menu_item_modifier_groups (menu_item_id, sort_order);

-- ---------------------------------------------------------------------------
-- 3. order_item_modifiers uniqueness (defensive; see header note 3)
-- ---------------------------------------------------------------------------
-- Collapse duplicates to the physically-first row per (order_item_id,
-- modifier_id): every row that has an earlier twin is deleted exactly once,
-- whatever its snapshot columns hold — a line's modifier rows are a set,
-- never a list, so two rows for one pair are always the old double-write.
DELETE FROM order_item_modifiers dup
  USING order_item_modifiers keep
 WHERE dup.ctid > keep.ctid
   AND dup.order_item_id = keep.order_item_id
   AND dup.modifier_id IS NOT NULL
   AND dup.modifier_id = keep.modifier_id;

ALTER TABLE order_item_modifiers
    DROP CONSTRAINT IF EXISTS uq_order_item_modifiers_item_modifier;
ALTER TABLE order_item_modifiers
    ADD CONSTRAINT uq_order_item_modifiers_item_modifier
    UNIQUE (order_item_id, modifier_id);

-- ---------------------------------------------------------------------------
-- 4. Name/SKU uniqueness — resolve existing duplicates, then constrain
-- ---------------------------------------------------------------------------

-- Categories: name is unique per location (the create route has always
-- refused duplicates; this makes the check race-safe).
UPDATE menu_categories c
   SET name = left(c.name, 180) || ' — تکراری ' || substr(c.id::text, 1, 8)
  FROM (
    SELECT id, row_number() OVER (PARTITION BY location_id, name
                                  ORDER BY created_at, id) AS rn
      FROM menu_categories
  ) r
 WHERE c.id = r.id AND r.rn > 1
   AND NOT EXISTS (  -- never turn a repair into a new collision
    SELECT 1 FROM menu_categories other
     WHERE other.location_id = c.location_id
       AND other.id <> c.id
       AND other.name = left(c.name, 180) || ' — تکراری ' || substr(c.id::text, 1, 8)
   );

ALTER TABLE menu_categories DROP CONSTRAINT IF EXISTS uq_menu_categories_location_name;
ALTER TABLE menu_categories
    ADD CONSTRAINT uq_menu_categories_location_name UNIQUE (location_id, name);

-- Menu-item SKU per location. Partial (sku IS NOT NULL): an empty SKU means
-- "no code", and any number of items may legitimately have none.
UPDATE menu_items i
   SET sku = left(i.sku, 100) || '-' || substr(i.id::text, 1, 8)
  FROM (
    SELECT id, row_number() OVER (PARTITION BY location_id, sku
                                  ORDER BY created_at, id) AS rn
      FROM menu_items
     WHERE sku IS NOT NULL
  ) r
 WHERE i.id = r.id AND r.rn > 1
   AND NOT EXISTS (
    SELECT 1 FROM menu_items other
     WHERE other.location_id = i.location_id
       AND other.id <> i.id
       AND other.sku = left(i.sku, 100) || '-' || substr(i.id::text, 1, 8)
   );

DROP INDEX IF EXISTS uq_menu_items_location_sku;
CREATE UNIQUE INDEX uq_menu_items_location_sku
    ON menu_items (location_id, sku) WHERE sku IS NOT NULL;

-- Modifier groups and their options: unique *while active*. A deactivated
-- group/option is retained history, and recreating a same-named replacement
-- is a legitimate operation the partial indexes therefore still allow.
UPDATE modifier_groups g
   SET name = left(g.name, 180) || ' — تکراری ' || substr(g.id::text, 1, 8)
  FROM (
    SELECT id, row_number() OVER (PARTITION BY location_id, name
                                  ORDER BY created_at, id) AS rn
      FROM modifier_groups
     WHERE is_active
  ) r
 WHERE g.id = r.id AND r.rn > 1
   AND NOT EXISTS (
    SELECT 1 FROM modifier_groups other
     WHERE other.location_id = g.location_id
       AND other.id <> g.id
       AND other.name = left(g.name, 180) || ' — تکراری ' || substr(g.id::text, 1, 8)
   );

DROP INDEX IF EXISTS uq_modifier_groups_location_name;
CREATE UNIQUE INDEX uq_modifier_groups_location_name
    ON modifier_groups (location_id, name) WHERE is_active;

UPDATE modifiers m
   SET name = left(m.name, 180) || ' — تکراری ' || substr(m.id::text, 1, 8)
  FROM (
    SELECT id, row_number() OVER (PARTITION BY group_id, name
                                  ORDER BY id) AS rn
      FROM modifiers
     WHERE is_active
  ) r
 WHERE m.id = r.id AND r.rn > 1
   AND NOT EXISTS (
    SELECT 1 FROM modifiers other
     WHERE other.group_id = m.group_id
       AND other.id <> m.id
       AND other.name = left(m.name, 180) || ' — تکراری ' || substr(m.id::text, 1, 8)
   );

DROP INDEX IF EXISTS uq_modifiers_group_name;
CREATE UNIQUE INDEX uq_modifiers_group_name
    ON modifiers (group_id, name) WHERE is_active;
