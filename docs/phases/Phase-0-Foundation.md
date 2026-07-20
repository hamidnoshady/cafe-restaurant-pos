# Phase 0 — Foundation

**Project:** Cafe/Restaurant POS
**Depends on:** nothing (first phase)
**Goal:** Working skeleton — schema, auth, multi-location scaffolding, RTL shell. No business features yet.

---

## Scope

- Full Postgres schema + migrations, covering *all* tables from the master spec (even later-phase ones) — easier to migrate once than incrementally
- Auth: JWT sessions (Owner/Manager) + PIN quick-login (Cashier/Waiter/Kitchen)
- Role scaffolding: owner, manager, cashier, waiter, kitchen
- Multi-location scaffolding — `location_id` present on every tenant-scoped table, even though v1 may run one location
- Next.js app shell: `dir="rtl"`, Tailwind logical properties, Vazirmatn font loaded
- Jalali calendar utility (convert ISO ⇄ Jalali at display layer only; store ISO always)
- Persian digit formatting utility (display only; store Latin numerals)
- Money utility: store as integer smallest-unit (Rial), format as Toman/Rial for display

## Out of scope (later phases)

- Setup wizard UI
- Any actual menu/order/inventory/ledger logic
- Printing, hardware, offline queue
- Reporting

## Exit criteria

- Can seed one Owner user and log in
- Empty RTL dashboard shell renders correctly (right-to-left, Persian font, no layout mirroring bugs)
- Schema migrations run clean on an empty Postgres instance
- A test date round-trips ISO → Jalali display → back with no drift
- A test amount stored as integer rial displays correctly formatted as Toman

---

## Questions to answer before/during this phase

1. **Hosting for Postgres in dev** — do you want Postgres running locally (Docker) on your dev machine, or should Claude Code assume a specific target (e.g. the eventual on-site mini PC) from the start?
2. **Repo structure** — one monorepo (API + all client apps together, e.g. Turborepo/Nx) or separate repos per app (cashier, waiter, KDS, dashboard)?
3. **Auth details** — how long should Owner/Manager JWT sessions last before re-login? Any requirement for 2FA for Owner accounts?
4. **PIN login** — how many digits for cashier/waiter PINs, and should PINs be unique per location or per business?
5. **Persian font licensing** — Vazirmatn is open-source (SIL license) so no issue, just confirming you want it as the *only* font, or a fallback stack for numbers/Latin text (e.g. product SKUs)?
6. **Node/Postgres versions** — any constraints (e.g. matching a hosting provider's supported versions) or should Claude Code pick current stable versions?
