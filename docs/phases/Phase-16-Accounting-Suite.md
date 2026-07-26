# Phase 16 — Real Accounting Suite

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 12 (tenant-safe ledger), Phase 13 (`accountant` role)
**Goal:** Turn the existing double-entry ledger into an accounting system an accountant can actually close a year on.

---

## Scope

What exists after Phase 7: a double-entry ledger, a Persian F&B chart of accounts, auto-posting for payments, purchases, COGS and waste, and a trial balance. What this phase adds:

- **Fiscal years and periods** — define them per business, soft-close and hard-lock a period so nothing can post into it, with a controlled reopen. Year-end closing entries rolling P&L into retained earnings.
- **Financial statements** — profit & loss, balance sheet, and cash flow, each with period comparison and drill-down to the journal entries behind any figure.
- **AR subledger** — customer balances, invoices, receipts, aging buckets, statements. `accounts_receivable` is posted to today but has no subledger behind it.
- **AP subledger** — supplier balances, bills against purchase receipts, payments, aging, statements.
- **Bank & cash reconciliation** — import or enter a statement, match against `cash` / `bankClearing` postings, carry unreconciled items, lock a reconciled period.
- **Expense management** — categorised operating expenses with attachments, recurring expenses, and their postings.
- **Payroll entries** — staff cost accrual and payment postings (journal-level, not a payroll engine).
- **Manual journals, properly** — draft → review → post workflow, reversal rather than deletion, recurring templates, and an approval permission distinct from posting.
- **Per-business chart of accounts** — customisation, sub-accounts, and account archival that respects existing postings.
- **VAT / tax reporting** — output vs input VAT, payable position, and a return-shaped report.

## Out of scope

- Iranian statutory e-invoicing (سامانه مودیان) and official ledger exports — a large integration in its own right; revisit after this lands.
- Multi-currency and FX revaluation — the storage convention is integer Rial throughout and changing that touches every money path in the system.
- A payroll engine (tax tables, insurance, payslips).

## Exit criteria

- A full fiscal year can be closed: periods locked, closing entries posted, statements produced, and the balance sheet balances.
- P&L and balance sheet agree with the trial balance, and every figure drills through to its journal lines.
- AR and AP aging totals agree with their control accounts to the Rial.
- A locked period rejects every posting path, including the automatic ones (order payment, purchase receipt, waste, inventory adjustment).
- Reversing an entry leaves both the original and the reversal visible and the net effect zero.

## Open questions → decisions

1. **Fiscal year** — the Jalali year (فروردین–اسفند), no configurable start month. Simplest default; revisit only if a business genuinely needs otherwise.
2. **AR invoices** — no new document type. An order with `credit` payment method is the invoice; the AR subledger reads off orders already marked credit.
3. **Closed-but-not-locked posting** — owner and accountant, not accountant-only. Matches `ledger.close_period`'s existing role preset (see `permissions.ts`).
4. **Statement format** — a clean internal format for now; statutory Persian formatting (already out of scope alongside e-invoicing) can follow later.
5. **Bank reconciliation import** — manual entry first; a bank-file import format is deferred until reconciliation itself is built.
6. **AR customer attribution** — orders had a `customer_id` column since Phase 1 but nothing populated it. Checkout now requires picking or creating a customer when the payment method is `credit`, so the subledger has a real entity to group by going forward; existing/legacy credit orders with no customer stay grouped under an explicit "unknown" bucket rather than being dropped, so totals still agree with the control account to the Rial.
7. **AR collection** — built now, not deferred: a credit order posts as fully "settled" the instant it's rung up (no partial-payment order state), so without a way to record the customer later paying it down, the subledger could only ever grow. `ar_receipts` + `receivePayment` (`ar-service.ts`) is that missing other half.

## Progress

Built incrementally, in dependency order (statements need periods to close against; subledgers etc. come after):

- **Fiscal years & periods — implemented.** `migrations/0024_fiscal_periods.sql` (`fiscal_years`, `fiscal_periods`, RLS), `src/lib/fiscal-periods.ts` (pure: Jalali year → twelve period boundaries, status-transition rules), `src/lib/fiscal-periods-service.ts` (create a year, list, transition a period's status), `/api/ledger/fiscal-years` + `/api/ledger/fiscal-years/[id]/periods` + `/api/ledger/fiscal-periods/[id]`, and a "دوره‌های مالی" tab in the ledger dashboard. The lock itself is enforced by a trigger on `journal_entries` (`enforce_fiscal_period_lock`), not trusted at the app layer, so it rejects every posting path without exception — including the automatic ones, since they all funnel through `postJournalEntry()`. Locked always rejects; soft-closed rejects everyone except the owner or an accountant. Verified in `integration/fiscal-periods.integration.test.ts` and `src/lib/fiscal-periods.test.ts`, and manually end-to-end (API + UI) against a real server.
- **Financial statements: period comparison and drill-down — implemented, plus a new cash flow statement.** P&L and Balance Sheet already existed (Phase 8); this phase adds: a cash flow statement (`getCashFlow` in `reports-service.ts`) using the direct method, grouping every cash/bank-clearing movement by the `journal_entries.source_type` that posted it (order, purchase, manual, …) rather than inventing a new account-classification scheme; "vs previous period" comparison for all three statements (`getProfitAndLossComparison`/`getCashFlowComparison` mirror the given range's length automatically via `previousPeriodRange` in `reports.ts`, Balance Sheet takes an explicit `previousAsOfDate` since a snapshot has no length to mirror); and drill-down (`getAccountDrillDown` + `/api/reports/drill-down`, a click-through overlay in the dashboard) showing the exact journal entries behind any line in any of the three statements. Also fixed the same pre-existing gap as fiscal periods: the reports pages/APIs and the ledger APIs excluded the `accountant` role despite `reportsView`/`reportsExport` being in its permission preset since Phase 13. Verified in `integration/financial-statements.integration.test.ts`, `src/lib/reports.test.ts`, and manually end-to-end (API + UI, including the drill-down overlay) against a real server.
- **Closing entries — implemented.** `closeFiscalYear` (`src/lib/closing-service.ts`) rolls a fiscal year's revenue/expense accounts into a new "Retained Earnings" equity account (code 3800, added to `WELL_KNOWN_CODES`/`FNB_COA_TEMPLATE` and backfilled onto every existing business by `migrations/0025_closing_entries.sql`, the same pattern migration 0017 used for an earlier well-known-account addition). Requires every one of the year's twelve periods to already be `soft_closed`; posts one closing entry dated on the year's last day — while the last period is still soft_closed, so no special case was needed in migration 0024's lock trigger — then locks every period and stamps `fiscal_years.closed_at` in the same transaction. A period whose fiscal year is already closed can no longer be individually reopened (`setPeriodStatus` guards this). Exposed via `POST /api/ledger/fiscal-years/[id]/close` and a "بستن سال مالی" button in the fiscal-periods tab, enabled only once every period is soft_closed. Also fixed two more instances of the same accountant-role gap fixed twice already in this phase: the fiscal-years/periods GET routes still excluded `accountant`. Verified in `integration/closing-entries.integration.test.ts` and manually end-to-end (API, UI, and the reopen-after-close rejection) against a real server — confirmed the closing entry zeroes the year's revenue/expense accounts to the Rial and posts the exact net income/loss to Retained Earnings.
- **AR subledger — implemented.** A credit order is the invoice (no new document type, per the phase's original resolved question) and now carries a real `customer_id`: checkout (`order-detail.tsx`) requires picking or creating a customer whenever the payment method is `credit`, via a new business-wide `customers` search/create API (`/api/customers`, `src/lib/customers-service.ts`). `src/lib/ar.ts` (pure: FIFO-applies a customer's total receipts against their oldest invoices first, buckets what's left by age — current/31-60/61-90/90+) plus `src/lib/ar-service.ts` (DB-touching: every figure — balances, statements, aging — is reconstructed from the same journal lines posted to the Accounts Receivable control account, attributed to a customer via the order or receipt that caused each line, never a shadow copy, so totals agree with the control account to the Rial by construction). `receivePayment` posts the other half of the lifecycle a credit order's instant-settlement design left missing: Debit Cash/Bank-Clearing, Credit Accounts Receivable, against a new `ar_receipts` table (`migrations/0026_ar_receipts.sql`). Exposed via `/api/ledger/ar/{customers,customers/[id],aging,receipts}` (same owner/manager/accountant access as the rest of the ledger surface) and a "حساب‌های دریافتنی" tab (balances, per-customer statement overlay, aging report, receive-payment dialog). Verified in `src/lib/ar.test.ts` (aging math), `integration/ar.integration.test.ts` (balances/statement/aging/receipt-posting against real posted entries), and manually end-to-end (checkout → credit payment → customer picker → AR tab → receive payment → balance drops) against a real server. That manual pass surfaced two unrelated, pre-existing, critical bugs — fixed alongside since they blocked checkout entirely: `/api/orders/[id]/pay` and `/api/inventory/stock-counts`'s `inventory_events` inserts each reused one bound parameter as both a `uuid` column value and inside a `'...' || $n` text concatenation, which Postgres deterministically rejects ("inconsistent types deduced") — every order payment and every stock count adjustment was failing before this fix. Same bug class already fixed twice before in this codebase (`team-service.ts`, `branch-service.ts`); fixed here the same way, by giving each context its own parameter.
- AP subledger, bank reconciliation, expense management, payroll entries, manual-journal workflow, chart-of-accounts customisation, and VAT/tax reporting — not yet started.
