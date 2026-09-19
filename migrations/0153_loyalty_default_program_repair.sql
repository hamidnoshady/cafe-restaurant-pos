-- Loyalty follow-up — a default must be an active programme.
--
-- Earlier writes could leave an active programme with no default (or keep the
-- old default marked while it was inactive). The earning/redeeming service now
-- treats "default" as a real invariant rather than choosing an arbitrary
-- active row, so repair those historical configurations deterministically:
-- deactivate no programmes, merely clear an inactive default and select the
-- oldest active programme for each affected business. The service serializes
-- every later change to preserve the same invariant.

UPDATE loyalty_programs
   SET is_default = false
 WHERE is_default AND NOT is_active;

WITH selected AS (
  SELECT DISTINCT ON (business_id) id
    FROM loyalty_programs candidate
   WHERE is_active
     AND NOT EXISTS (
       SELECT 1
         FROM loyalty_programs active_default
        WHERE active_default.business_id = candidate.business_id
          AND active_default.is_active
          AND active_default.is_default
     )
   ORDER BY business_id, created_at, id
)
UPDATE loyalty_programs program
   SET is_default = true
  FROM selected
 WHERE program.id = selected.id;
