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

## Open questions

1. Is the chart of accounts shared across a business's branches (it is business-scoped today) or should branches be able to diverge?
2. Should order numbering stay per-branch (it is today) or become per-business?
3. When a branch is deactivated, what happens to its open orders, stock on hand and unposted entries?
4. Does a consolidated view need to handle branches in different timezones, or is one business always one timezone?
