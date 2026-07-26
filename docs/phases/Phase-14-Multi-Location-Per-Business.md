# Phase 14 — Multi-Location Per Business

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12, Phase 13
**Goal:** A business runs several branches from one account — each with its own menu, stock and till, consolidated where it matters.

---

## Scope

- **Retire the single-location assumption** — replace the 61 call sites of `getPrimaryLocation` with explicit resolution of the caller's active branch, validated against their `user_locations` assignments.
- **Branch switcher** — a persistent control in the dashboard shell; the active branch lives in the session and every scoped screen follows it.
- **Branch provisioning** — an owner creates, renames, deactivates a branch, and chooses what to copy from an existing one (menu, chart of accounts, recipes, printers).
- **Consolidated reporting** — per-business roll-up across its own branches, distinct from the Phase 9 cross-*server* rollup, which stays as-is for on-premise deployments.
- **Cross-branch inventory transfers** — the `inventory_transfers` tables already exist; wire them to a real branch-to-branch flow with both sides' ledger postings.
- **Local-server story** — a branch's on-premise server syncs to the central multi-business deployment as exactly one business (per the Phase 12 decision that local installs stay single-tenant).

## Out of scope

- Per-branch pricing strategy and menu variance beyond copy-on-create.
- Franchise-style separate legal entities under one business (that is several businesses).

## Exit criteria

- A business with three branches shows correct per-branch and consolidated numbers, and the two reconcile.
- A member assigned to branch B cannot read branch A's orders, stock or till, even within their own business.
- Switching branches never leaks stale data from the previous one.
- An inventory transfer between two branches balances on both sides of the ledger.

## Decisions on Phase 14 open questions

1. **Chart of accounts** — **stays shared across a business's branches**, unchanged from today. This was the lower-churn default (no schema change, and it matches how a single set of books usually works for one legal business with several storefronts). Revisiting this later is additive — per-branch sub-accounts could be introduced without breaking anything that reads the shared chart today.
2. **Order numbering** — **stays per-branch**, unchanged from today (`UNIQUE (location_id, order_number)`, migration 0001). Also the lower-churn default; moving to per-business numbering would touch the order-creation path and every place that displays an order number.
3. **Deactivating a branch** — soft and reversible: the branch drops out of `businessLocations()` (the query every access check and default-resolution call goes through), so no member can switch into it and it stops being anyone's default — while every historical row (orders, stock movements, journal entries) stays exactly where it is and remains fully reportable. Blocked outright while the branch has an **open order** or an **open table session**, because allowing that would strand live operational state in a branch nobody can act in anymore. Draft purchases and unposted stock counts are not blocked — they have no "in progress on the floor" quality — they just become unreachable through the UI until the branch is reactivated (which is instant: `reactivateBranch` just flips the flag back).
4. **Timezones in the consolidated view** — **not handled specially**; `getBusinessOverview` reads the same day-bucketed reporting views (`v_sales_by_day` etc.) that already bucket each branch's own days in that branch's own `locations.timezone` (a Phase 8 decision). A business with branches in different timezones gets each branch's own correct business-day boundaries; the consolidated total is a same-currency sum, not a shared-calendar rollup, so this needed no new logic.

**Other decisions made while building:**

- **Cross-branch inventory transfers were already built.** `inventory_transfers` has carried `source_location_id`/`destination_location_id` since Phase 6, and `src/lib/transfer-service.ts` already ships/receives/cancels with journal postings on both sides — `operational-accounting.integration.test.ts`'s "ships, cancels, receives exactly once, and preserves transfer value" already proved the balance criterion before this phase started. Nothing to build here; the scope item was findable-but-not-actually-outstanding.
- **Access is application-enforced, not RLS-enforced, at the branch level.** Phase 12's row-level security draws its isolation boundary at the business, not the branch — a manager's Postgres session can technically read another branch's rows in the same business. The boundary a member assigned to one branch actually gets is `resolveActiveLocation` + `/api/auth/switch-location` refusing to hand them a session scoped to a branch they're not assigned to, both re-checking the database rather than trusting the token (same pattern as `requirePermission`). This is weaker than RLS in principle — a route that queries by hand without going through the resolved location could leak across branches — which is why the sweep replaced literally every route's location resolution rather than leaving some on the old `getPrimaryLocation`.
- **The `activeLocationId` session field degrades gracefully.** A token issued before this phase (or right after login, before any switch) simply lacks it; `resolveActiveLocation` treats that the same as "requested a branch I can't reach" and falls back to the caller's default accessible branch — which is exactly what `getPrimaryLocation` returned for every business that has only one branch. No forced re-login, and single-branch installs see no behavioural change at all.
- **The report letterhead (`reports/export`'s `getBusinessInfo`) deliberately kept using `getPrimaryLocation`.** A PDF's company address is "the business's address for print", not "whichever branch the viewer happens to be looking at" — the one call site in the sweep that stayed as it was, on purpose.

## Where each exit criterion is satisfied

- **Correct per-branch and consolidated numbers that reconcile** — `getBusinessOverview` (`src/lib/reports-service.ts`) computes both from the same Phase 8 views in one round of queries; `integration/branch-management.integration.test.ts`'s "consolidated reporting reconciles with per-branch numbers" block asserts the sum of branches equals the independently-computed consolidated total, including after a branch is deactivated.
- **A member assigned to branch B cannot read branch A's data** — `location-access.ts` (unit-tested, 14 cases) plus `resolveActiveLocation`/`accessibleLocationsFor` (`src/lib/setup-state.ts`); asserted against a real database in "branch access is confined to assignment".
- **Switching never leaks stale data** — every route resolves its branch fresh, per request, from the session's `activeLocationId`; asserted in "switching never leaks the previous branch's data".
- **Cross-branch transfers balance** — already true; see the note above. Not re-tested here to avoid duplicating `operational-accounting.integration.test.ts`.

## Known follow-ups

- Access at the branch level is application-enforced (see above), not database-enforced like the Phase 12 business boundary. Phase 17's isolation hardening is the natural place to decide whether that gap is worth closing with branch-level RLS.
- The branch switcher and management screen are new UI with no dedicated component tests — covered by `tsc`, the build, and the service-level integration tests, but not exercised through a browser in this pass.
- Per-user branch assignment (`user_locations`) has no picker in the team UI yet (noted as a Phase 13 follow-up); it's fully wired end-to-end (API, access rules, tests) and just needs the UI control.
