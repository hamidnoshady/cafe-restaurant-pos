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

## Open questions

1. Which fiscal year does a business use by default — the Jalali year (فروردین–اسفند) or a configurable start month?
2. Should AR invoices be a new document type, or is an order with `credit` payment method already the invoice?
3. Who may post to a closed-but-not-locked period — accountant only, or owner too?
4. Do statements need to be produced in a specific statutory Persian format, or is a clean internal format enough for now?
5. Should bank reconciliation support importing a bank file, and if so which format do the target banks actually export?
