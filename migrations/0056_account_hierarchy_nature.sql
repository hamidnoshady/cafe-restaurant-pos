-- ---------------------------------------------------------------------------
-- Account hierarchy levels & nature metadata (Phase 22 Wave 2, issue #160)
-- ---------------------------------------------------------------------------
-- Adds the standard Iranian-accounting four-tier chart-of-accounts
-- classification (گروه/کل/معین/تفصیلی) and debit/credit "nature" as explicit,
-- queryable metadata on top of the existing accounts.parent_id nesting and
-- accounts.type. Additive only — no existing posting or report behavior
-- changes; see docs/phases/Phase-22-Accounting-Standards-Compliance-Gap-Analysis.md
-- section 7.1/7.2.

CREATE TYPE account_level AS ENUM ('group', 'kol', 'moein', 'tafsili');

ALTER TABLE accounts
    ADD COLUMN level account_level NOT NULL DEFAULT 'group',
    -- Always derived from `type`, never set directly: asset/expense accounts
    -- carry a debit normal balance, liability/equity/revenue carry credit.
    -- A generated column keeps this correct for every insertion path (the
    -- accounts-service, the chart-of-accounts seeding/replace routes, and
    -- every existing raw-SQL fixture across the test suite) with no code
    -- changes required anywhere else, and no risk of drifting from `type`.
    ADD COLUMN normal_balance text GENERATED ALWAYS AS (
        CASE WHEN type IN ('asset', 'expense') THEN 'debit' ELSE 'credit' END
    ) STORED,
    -- A contra/reducing account (e.g. sales returns, an inventory NRV
    -- allowance) moves opposite its type's normal-balance direction.
    ADD COLUMN is_contra boolean NOT NULL DEFAULT false;

-- Backfill `level` for every account that existed before this migration, by
-- actual parent-chain depth (not a flat "root vs. everything else" guess): a
-- root account is `group`, each step down the existing parent_id chain is one
-- level deeper, capped at `tafsili` (the deepest standard tier) for any chart
-- already nested past four levels. Bounded to 10 hops purely defensively —
-- accounts.parent_id has no DB-level cycle guard, only the application-layer
-- one in accounts-service.ts's assertNoCycle.
WITH RECURSIVE depths AS (
    SELECT id, 0 AS depth FROM accounts WHERE parent_id IS NULL
    UNION ALL
    SELECT a.id, d.depth + 1
      FROM accounts a
      JOIN depths d ON a.parent_id = d.id
     WHERE d.depth < 10
)
UPDATE accounts a
   SET level = (ARRAY['group', 'kol', 'moein', 'tafsili']::account_level[])[LEAST(d.depth, 3) + 1]
  FROM depths d
 WHERE a.id = d.id;

-- Backfill `is_contra` for the two existing well-known accounts that already
-- behave as contra accounts today (see coa-template.ts) — matched by code,
-- the same pattern migrations 0025/0032 used to backfill a well-known account
-- onto every existing business.
UPDATE accounts SET is_contra = true WHERE code IN ('4400', '1390');
