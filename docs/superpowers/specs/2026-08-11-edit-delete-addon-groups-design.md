# Edit & Delete Add-on (Modifier) Groups — Design

**Date:** 2026-08-11
**Status:** Approved

## Scope

Add inline edit and delete actions for modifier groups ("add-on groups") in the menu
manager. The add-group form already exists; editing and deleting an existing group do not.

## What changes

Purely a frontend change in `src/app/dashboard/menu/menu-manager.tsx`. The API routes
already exist and are unchanged:

- `PATCH /api/menu/modifier-groups/[id]` — updates `name` / `min_select` / `max_select`.
- `DELETE /api/menu/modifier-groups/[id]` — deletes the group; `modifiers` and
  `menu_item_modifier_groups` rows cascade via `ON DELETE CASCADE`, and past order items
  are unaffected (they snapshot name/price and `SET NULL` the modifier id).

## UI

In `ModifierGroupRow` (the card per group):

1. **Header row** gains two buttons next to the group name: «ویرایش» (Edit) and «حذف»
   (Delete), matching the existing button patterns (`SecondaryButton`, `disabled={busy}`).
   - Edit toggles an `editing` state on the row.
   - Delete calls `window.confirm("گروه «<name>» و همهٔ افزودنی‌هایش حذف شود؟")` and on confirm
     calls the `DELETE` route.
2. **Edit form** replaces only the header while editing — the modifier list and the
   "add modifier" form stay visible below. Fields: name, min-select, max-select
   (numeric, LTR), pre-filled from the group. Save calls the `PATCH` route with
   `{ name, minSelect, maxSelect }`; on success exits edit mode. Cancel exits without
   saving. Mirrors the existing `EditModifierRow` / `EditItemRow` patterns.

## Data flow

`run(...)` (the existing wrapper) handles the API call, busy state, and `load()` refresh,
so the list reflects edits/deletes immediately.

## Validation

Name non-empty. min ≥ 0, max ≥ 1, min ≤ max — the same rules as the create form and the
PATCH route already enforce server-side.

## Testing

Manual: create a group, edit its name/bounds, verify the list updates; delete it and
verify it and its modifiers disappear. No `src/lib/` logic changes, so no unit test.
