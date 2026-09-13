-- ============================================================================
-- 0149_branch_color.sql — a per-branch identifying colour.
--
-- Multi-branch businesses gained a switcher in the shell header, and the one
-- question it has to answer at a glance is «الان در کدام شعبه‌ام؟». A name
-- alone does not do that: «شعبهٔ ونک» and «شعبهٔ ونک ۲» are one glance apart,
-- and the cost of misreading is real — an order rung up, stock counted, or a
-- till opened against the wrong branch.
--
-- Stored as a palette *key* ('rose', 'sky', …), not a hex string:
--
--   * The colour has to work in both themes. A hex picked in light mode is
--     frequently unreadable on the dark surface, and the row cannot know which
--     theme it will be painted in. A key maps to a light/dark pair chosen once
--     in src/lib/branch-color.ts.
--   * Tailwind compiles the classes it can see. A runtime hex would need
--     inline styles that bypass the token system, or a safelist of every
--     possible colour.
--   * It keeps the choice inside a set that is guaranteed distinguishable and
--     contrast-checked. A free picker lets someone choose two greys a
--     monitor cannot tell apart, which defeats the entire point.
--
-- The column is NOT NULL with a default because every branch must be
-- identifiable; `createBranch` picks the first unused palette entry when the
-- owner expresses no preference, so branches differ without anyone choosing.
--
-- Deliberately not an enum type: adding a colour to a Postgres enum needs a
-- migration and (before 12) could not run in a transaction, whereas the set
-- here is a presentation detail that belongs to the palette module. A CHECK
-- keeps the database honest without making the palette a schema object.
--
-- No RLS policy is added: `locations` has none (see 0021) — it is reached
-- through other tables' policies via app_current_business() — and a new
-- column on an existing table inherits whatever the table already enforces.
-- ============================================================================

ALTER TABLE locations
    ADD COLUMN color text NOT NULL DEFAULT 'slate'
        CHECK (color IN ('slate', 'rose', 'amber', 'emerald', 'sky', 'violet', 'teal', 'orange'));

-- Existing branches all carry the default, which would make every one of them
-- grey and the feature useless on the businesses that most need it. Spread
-- them over the palette in creation order, so the oldest branch keeps the
-- neutral slate and the rest are immediately distinct.
WITH ordered AS (
    SELECT id,
           row_number() OVER (PARTITION BY business_id ORDER BY created_at, id) - 1 AS position
      FROM locations
)
UPDATE locations AS l
   SET color = (ARRAY['slate', 'rose', 'amber', 'emerald', 'sky', 'violet', 'teal', 'orange'])[
           (ordered.position % 8) + 1
       ]
  FROM ordered
 WHERE ordered.id = l.id;
