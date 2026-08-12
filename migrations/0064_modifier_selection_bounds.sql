-- Make a modifier group's selection range unrepresentable when invalid.
--
-- 0001 declared min_select/max_select as plain `integer NOT NULL DEFAULT` with
-- nothing enforcing a relationship between them. That gap is load-bearing at
-- the point of sale rather than cosmetic: buildCart() in src/lib/order-cart.ts
-- rejects an order whose selected count for a group falls outside
-- [min_select, max_select], so a group saved with min > max makes EVERY order
-- containing an item linked to that group fail with invalid_modifier_selection,
-- and the confirm button in src/app/dashboard/modifier-picker.tsx can never
-- enable. The failure surfaces at the till, far from the menu screen that
-- caused it.
--
-- Both write paths now validate through resolveSelectionBounds()
-- (src/lib/modifier-selection.ts), so this constraint is the backstop for any
-- future caller — a script, an import, a hand-written UPDATE — rather than the
-- only line of defense.
--
-- max_select has no upper bound beyond int4: "how many add-ons may a group
-- offer" is a menu decision, and a group can legitimately hold more choices
-- than seems reasonable today.

-- Existing rows may already violate this (nothing stopped them until now), and
-- an ALTER that fails leaves the whole migration rolled back. Repair before
-- constraining, narrowly: only rows that are actually invalid, and only the
-- side that has to move. Raising max to min keeps every currently-required
-- selection satisfiable, where lowering min to max would silently relax a
-- group the operator deliberately made mandatory.
UPDATE modifier_groups SET min_select = 0 WHERE min_select < 0;
UPDATE modifier_groups SET max_select = 1 WHERE max_select < 1;
UPDATE modifier_groups SET max_select = min_select WHERE min_select > max_select;

ALTER TABLE modifier_groups
    ADD CONSTRAINT modifier_groups_selection_bounds CHECK (
        min_select >= 0 AND max_select >= 1 AND min_select <= max_select
    );
