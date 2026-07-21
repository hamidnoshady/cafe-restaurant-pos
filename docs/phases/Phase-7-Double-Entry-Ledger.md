# Phase 7 — Double-Entry Ledger

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–6
**Goal:** Every business event from earlier phases produces a correct, balanced journal entry. Trial balance always balances to zero.

---

## Scope

- Chart of Accounts (seeded from Phase 1's F&B template)
- Auto-posting journal entries triggered by:
  - Order paid (cash) → Debit Cash / Credit Sales Revenue + Tax Payable
  - Order paid (card/ZarinPal) → Debit Bank/Clearing / Credit Sales Revenue + Tax Payable
  - Stock deducted on sale (from Phase 6) → Debit COGS / Credit Inventory Asset
  - Purchase received (from Phase 6) → Debit Inventory Asset / Credit Accounts Payable or Cash
  - Waste logged (from Phase 6) → Debit Waste Expense / Credit Inventory Asset
  - Manual expense entry (new in this phase) → Debit Expense category / Credit Cash/Bank
- Manual journal entry capability for anything not auto-generated (with correct permission gating — likely Owner/Manager only)
- Trial balance report (sum of all debits = sum of all credits, always)

## Out of scope (later phases)

- Full P&L/Balance Sheet report *presentation* (Phase 8 builds these as reporting views on top of this ledger)

## Exit criteria

- Every order payment, stock deduction, purchase, and waste event from Phases 2–6 produces a correctly balanced journal entry automatically
- Manually entering an expense produces a correct balanced entry
- Trial balance report always sums to zero across all accounts
- Attempting to post an unbalanced entry (if manual entry allows it) is rejected

---

## Questions to answer before/during this phase

1. **Manual expense categories** — what are your actual recurring expense categories (rent, utilities, wages, supplies, marketing, etc.)? This shapes the expense side of the Chart of Accounts.
2. **Accounts Payable handling** — do purchases typically get paid immediately (straight to Cash/Bank), or do you carry supplier credit terms (need real Accounts Payable tracking with due dates)?
3. **Multi-location ledger** — should each location have its own separate set of books (separate trial balance per location), or one consolidated ledger with location as a dimension?
4. **Tax payable settlement** — how/when does collected tax get remitted, and do you want a specific "settle tax payable" action tracked in the ledger?
5. **Manual journal entry permissions** — should Managers be able to post manual entries, or is that Owner-only?
6. **Fiscal year** — does your business use the standard Iranian fiscal year for reporting periods, and when does it start?

---

## Decisions on Phase 7 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Manual expense categories** — the F&B template already covered wages (5200), rent (5300), utilities (5400) and supplies (5500); a **marketing account (5600 «بازاریابی و تبلیغات»)** was added since it wasn't there, alongside «سایر هزینه‌ها» (5900) as a catch-all. Manual expense entry isn't a separate feature — it's the generic manual-entry form (`/dashboard/ledger` → «ثبت سند دستی») with any expense account debited and Cash/Bank credited, so no new categories are hard-coded beyond the chart itself.
2. **Accounts Payable handling** — real AP tracking, not straight-to-cash-only: `purchases` gained a `settlement_method` column (`'cash' | 'bank' | 'credit'`, **default `'credit'`**) set at receiving time (`PATCH /api/inventory/purchases/[id]`, not at draft/PO creation — a draft doesn't need this yet). `'credit'` posts to Accounts Payable (2100); `'cash'`/`'bank'` post straight to Cash/Bank-Clearing instead, for suppliers paid on the spot. The purchasing UI lets picking per-receipt.
3. **Multi-location ledger** — one consolidated ledger, matching the schema's existing design (`accounts` and `journal_entries.business_id` are business-scoped, not location-scoped — `journal_entries.location_id` is just a nullable dimension) and the project-wide "v1 is single-location per business" rule (see CLAUDE.md). Nothing to build here — it already fell out of the Phase 0 schema.
4. **Tax payable settlement** — no dedicated "settle tax" endpoint; it's just another manual entry (Debit Tax Payable 2200 / Credit Cash or Bank), same as a manual expense. Didn't justify its own action for v1.
5. **Manual journal entry permissions** — Owner/Manager only, matching every other back-office/financial surface (`/dashboard/ledger`, same as `/dashboard/inventory`'s admin tabs — see Phase 6 decision 6).
6. **Fiscal year** — no fiscal-year logic in this phase; `journal_entries.entry_date` is stored ISO/Gregorian per the project's date convention, same as everywhere else. Period grouping (Iranian fiscal year, Jalali-calendar reporting periods) is a Phase 8 reporting concern, built on `src/lib/jalali.ts` against this same `entry_date` column — this phase just needed *a* date, not a period system.

**Other decisions made while building:**

- **No per-category revenue split** — the template still carries «فروش غذا»/«فروش نوشیدنی» (4100/4200) from Phase 1, but nothing in the schema links a `menu_categories` row to a revenue account, so auto-posting can't split by category. A new **general Sales Revenue account (4300 «فروش (عمومی)»)** was added and is what every order's revenue actually posts to; 4100/4200 stay available for manual use or a future category→account mapping (Phase 8/9), but aren't wired into auto-posting.
- **New well-known accounts** — `WELL_KNOWN_CODES` (`src/lib/coa-template.ts`) grew: `bankClearing` (1120, already existed — now used for card/card_to_card/online payments and bank-settled purchases), `accountsReceivable` (1200, for the `credit` order-payment method — a customer tab), `accountsPayable` (2100), `salesRevenue` (4300, new), `cogs` (5100, already existed), `wasteExpense` (5150, new — the template had no waste account before this phase). `coa-template.test.ts` already asserted every well-known code exists in the template, so it caught this automatically.
- **Order revenue split** — order payment posts the collected `total` as the debit, and splits the credit side into `tax` (→ Tax Payable) and `total − tax` (→ Sales Revenue). Service charge and any pre-tax discount are folded into that revenue figure (no separate service-charge or sales-discount contra account) — the ledger doesn't need to reconstruct receipt line items, just the correct balanced totals.
- **Missing well-known account = hard stop, not silent skip** — if a business customized its chart of accounts (Phase 1 allows editing/removing rows) and deleted a well-known account, auto-posting throws `MissingLedgerAccountError` inside the same transaction as the triggering event (payment, purchase receipt, waste entry), which rolls everything back and returns `409 ledger_account_missing` rather than completing the sale/purchase/waste with a missing or partial journal entry. This can't happen via the wizard's default flow (`accounts === 0` blocks finishing setup — see `computeSetupState`), only if someone later edits the chart down to fewer accounts.
- **Two entries per sale, not one** — order payment and the COGS/inventory entry are posted as two separate `journal_entries` rows (same transaction, same `source_type: 'order'`, same `source_id`) rather than one five-line entry, since they're conceptually distinct events (revenue recognition vs. cost of the goods sold) and mirrors `deductForOrder`'s already-separate COGS total from Phase 6.
- **Balance enforced in the app layer, at two levels** — `journal_lines` already had a DB-level `debit XOR credit` CHECK per line (Phase 0 stub); *entry*-level balance (sum debit = sum credit) is enforced in `postJournalEntry` (`src/lib/ledger-service.ts`) for auto-posted entries and inline in `POST /api/ledger/entries` for manual ones — both reject before any row is written, same pattern the opening-balance step (Phase 1) already used.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Order payment produces a balanced entry (Cash/Bank-Clearing/Accounts-Receivable / Sales Revenue + Tax Payable) | `postOrderPaymentEntry` (`src/lib/ledger-service.ts`) + `buildOrderPaymentLines` (`src/lib/ledger.ts`), called from `POST /api/orders/[id]/pay` in the same transaction as payment recording |
| Stock deduction on sale produces a balanced COGS entry | `postCogsEntry` + `buildCogsLines`, using `deductForOrder`'s returned `totalCost`, same transaction as above |
| Purchase received produces a balanced entry (Inventory / AP or Cash/Bank) | `postPurchaseEntry` + `buildPurchaseLines`, called from `PATCH /api/inventory/purchases/[id]` when transitioning to `received` |
| Waste logged produces a balanced entry (Waste Expense / Inventory) | `postWasteEntry` + `buildWasteLines`, called from `POST /api/inventory/waste` |
| Manual expense entry produces a correct balanced entry | `POST /api/ledger/entries` (generic manual entry, owner/manager only) — the ledger UI's «ثبت سند دستی» tab |
| Trial balance always sums to zero across all accounts | `GET /api/ledger/trial-balance` — sums `journal_lines` per account; `balanced` is always true by construction since every posting path validates balance before insert |
| Unbalanced manual entry is rejected | `POST /api/ledger/entries` checks `totalDebit === totalCredit` before opening a transaction; `validateJournalLines`/`checkBalance` (`src/lib/ledger.ts`, unit-tested) back both the manual route and every auto-posting path in `ledger-service.ts` |

Dashboard UI: `/dashboard/ledger` (`src/app/dashboard/ledger/ledger-manager.tsx`) — tabs for trial balance, journal (all auto-posted + manual entries with their lines), and manual entry. Purchasing UI (`/dashboard/inventory` → «خرید») gained a settlement-method picker (نقدی/بانک/نسیه) shown at receive time.
