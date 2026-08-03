# Phase 22 — Accounting Standards Compliance & Multi-Industry COA

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 7 (double-entry ledger), Phase 16 (accounting suite), Phase 21 (multi-industry
accounting platform)
**Tracks:** GitHub issue [#160](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/160)
**Goal (of #160 as a whole):** bring the accounting layer — terminology, chart-of-accounts structure,
and industry coverage — up to a standard an accountant would recognize as correct, and make it
extensible to future industries without touching Core Accounting each time.

This document is Wave 1 of #160: **"Audit کامل وضعیت فعلی حسابداری و تهیه Gap Analysis"** (a
complete audit of the current accounting state and a gap analysis). It does not change any code —
it inventories what already exists, maps it against every scope item #160 lists, and turns what's
left into a concrete, sequenced backlog for Waves 2+.

---

## 0. Why this audit changes the shape of the remaining waves

#160 was written as if the accounting layer were being built from a blank slate: its own Wave-Based
plan (§8) proposes "Wave 2: fix Core Accounting Engine and the account data model", "Wave 3: redesign
a standard general chart of accounts", "Wave 5: jewelry template", etc.

That's not the starting state. **Three phases already shipped most of this:**

- **Phase 7** — double-entry ledger, a Persian F&B chart of accounts, auto-posting for order
  payment/COGS/purchases/waste, trial balance.
- **Phase 16** — fiscal years/periods with hard locks, P&L/Balance Sheet/Cash Flow with drill-down,
  year-end closing entries into retained earnings, AR and AP subledgers with aging, bank/cash
  reconciliation, a draft→review→post manual-journal workflow with reversal, chart-of-accounts
  customization (sub-accounts, rename, archive, protected delete), expense management, payroll
  accrual/payment, VAT reporting.
- **Phase 21** — the exact "multi-industry platform" #160 asks for in its §6 and §5: an immutable
  `businesses.industry` column, a domain-event log + posting-rule engine industry modules register
  against (instead of copy-pasting ledger code per industry), a generic Item/Variant/Serial model, and
  — critically — **Waves 1-4 of a full jewelry (طلا و جواهر) accounting module already shipped**:
  weight/purity tracking, daily gold pricing, the making-charge/profit/VAT formula, stone cost
  add-ons, and consignment (امانی) sale posting with its own subledger-style liability account —
  reachable today through `/api/jewelry/*` and `/dashboard/jewelry`.

So #160's real job is narrower than its own wave plan implies: **standards/terminology hardening on
top of an already-working double-entry system**, plus finishing the two industries Phase 21 hasn't
reached yet (watch, accessories — already Phase 21's own Waves 5-6). Duplicating Phase 21's jewelry
work under a new #160 "Wave 5" would be redoing shipped work; the gap analysis below is written to
avoid that.

---

## 1. Common Accounting Core (#160 §1) — mapped

| §1 item | Status | Where |
|---|---|---|
| Chart of Accounts | **Exists** | `src/lib/coa-template.ts` (`FNB_COA_TEMPLATE`, `JEWELRY_COA_TEMPLATE`), `accounts` table (migration 0001) |
| گروه/کل/معین/تفصیلی (group / general-ledger / subsidiary-ledger / detail-ledger hierarchy) | **Gap** | See §7.1 below — only generic `parent_id` nesting exists, no standard 4-tier level classification |
| ماهیت بدهکار/بستانکار (debit/credit nature) | **Partial gap** | Inferred implicitly from `account.type` in report code (e.g. `reports-service.ts:225`); never stored or surfaced as an explicit "nature" field. See §7.2 |
| حسابهای عادی و کاهنده (normal vs. contra/reducing accounts) | **Gap** | `salesReturns` (4400), `nrvAllowance` (1390) behave as contra accounts today but nothing marks them as such — no `is_contra` concept anywhere in `src/lib`. See §7.2 |
| حسابهای موقت و دائمی (temporary vs. permanent accounts) | **Implicit, not modeled** | Revenue/expense accounts are temporary in effect (zeroed by `closeFiscalYear`, `src/lib/closing-service.ts`) but this falls out of `account.type`, not an explicit flag |
| حسابهای کنترلی (control accounts) | **Exists, implicit** | `accountsReceivable`/`accountsPayable` behave as control accounts (AR/AP subledgers reconcile to them "to the Rial" by construction, Phase 16) but again, not a named/marked concept |
| حسابهای سیستمی و غیرقابل حذف (system / non-deletable accounts) | **Exists** | `WELL_KNOWN_CODES` (`coa-template.ts`) protected in `accounts-service.ts`'s `setAccountActive`/`deleteAccount` — a well-known code can never be archived or deleted. Not surfaced as a UI-visible "این حساب سیستمی است" badge distinct from the generic archive/delete-blocked state |
| بستن دوره مالی (period close) | **Exists** | Phase 16 fiscal years/periods, `enforce_fiscal_period_lock` trigger |
| افتتاحیه و اختتامیه (opening/closing entries) | **Exists** | Opening: Phase 1 wizard opening balances → `openingEquity`/`historicalInventoryReconciliationEquity`. Closing: `closeFiscalYear` → `retainedEarnings` |
| سود و زیان انباشته (retained earnings) | **Exists** | Well-known code 3800, migration 0025 |
| تراز آزمایشی (trial balance) | **Exists** | `GET /api/ledger/trial-balance`, "تراز آزمایشی" tab |
| دفتر کل و معین (general ledger & subsidiary ledger) | **Partial gap** | The "دفتر روزنامه" (journal) tab, `getAccountDrillDown`, and the report builder's `v_ledger_by_account` ("دفتر حساب‌ها") view (`src/lib/reports.ts:132-151`, debit/credit summed by account/day/week/month) together cover the underlying data, but none of them is a dedicated per-account statement with a running opening→closing balance — the standard دفتر معین presentation. See §7.3 |
| صورت سود و زیان (P&L) | **Exists** | Phase 16, with period comparison |
| ترازنامه (balance sheet) | **Exists** | Phase 16, with period comparison |
| گردش حسابها (account turnover/movement) | **Partial gap** | Same as دفتر معین above — the data exists (`getAccountDrillDown`, `v_ledger_by_account`), the reporting surface doesn't name or format it as a standalone گردش حساب statement |

**Wave 1 conclusion for §1:** the *mechanics* of double-entry accounting are sound and tested (899+
unit tests, 300+ integration tests at last count in Phase 21's progress log). What's missing is the
**explicit standards vocabulary layered on top of the mechanics** — level classification, nature/
contra flags, and named report surfaces for دفتر کل/دفتر معین/گردش حساب. None of this requires
touching the ledger's posting logic; it's additive metadata and reporting, which is exactly why it's
scoped as its own core-engine wave (see §8, Wave 2) rather than a rewrite.

## 2. Account structure sections (#160 §2) — mapped

Assets/liabilities/equity/revenue/expense/COGS/inventory/fixed-assets/depreciation/reserves/
suspense/clearing accounts:

| Item | Status |
|---|---|
| دارایی‌ها / بدهی‌ها / حقوق صاحبان سرمایه / درآمدها / هزینه‌ها | **Exists** — `AccountType` (`coa-template.ts`) |
| بهای تمام‌شده (COGS) | **Exists** — `cogs` (5100), `goldCogs` (5110), `COST_OF_SALES_CODES` groups material-cost-vs-overhead for a multi-step income statement |
| موجودی کالا (inventory) | **Exists** — `inventory` (1300, F&B), `goldInventory` (1320), full FIFO/weighted-average/NRV costing (Phase 6, `inventory-exact.ts` and friends) |
| دارایی ثابت (fixed assets) | **Gap** | `1500 اثاثه و تجهیزات` exists as one flat asset line; no fixed-asset register, no depreciation schedule/posting |
| استهلاک (depreciation) | **Gap** | No depreciation account, no depreciation posting path anywhere in `src/lib` |
| ذخایر (reserves/provisions) | **Partial** | `nrvAllowance` (1390) is a real provision account (inventory NRV write-down); no general-purpose "reserve" account type or pattern beyond that one case |
| حسابهای واسط (clearing/suspense — intermediary) | **Exists** | `bankClearing` (1120) is exactly this pattern for card/online payment settlement |
| حسابهای تعلیقی (suspense accounts, in the "uncategorized, to be resolved" sense) | **Gap** | No general suspense-account concept for miscategorized/pending postings |

**Wave 1 conclusion for §2:** fixed-asset register + depreciation is the one genuinely unbuilt
sub-domain here (everything else is either shipped or is a metadata/labeling gap, same class as §1).

## 3. Terminology control (#160 §3, and the added §9 UI/UX requirement)

Checked what Persian accounting vocabulary the product already uses (grep across `src/app/dashboard`
and `src/lib`):

- Correctly-used standard terms already in the UI: تراز آزمایشی (trial balance), دفتر روزنامه
  (journal — though see دفتر کل/معین gap above), صورت سود و زیان, ترازنامه, حساب‌های دریافتنی/
  پرداختنی, سند حسابداری (implicitly, via "ثبت سند دستی").
- Terms #160 explicitly calls out that are **not present anywhere**: معین، تفصیلی، ماهیت (نات),
  حساب کاهنده، حساب سیستمی (as a labeled concept), دفتر کل (as distinct from دفتر روزنامه), گردش
  حساب.
- No systematic terminology audit has ever been done — labels were written phase-by-phase, each
  phase choosing its own wording locally (reasonably, since no phase before #160 had "Persian
  accounting-standard terminology consistency" as an explicit goal).

**Gap:** a full label-by-label pass across every accounting-adjacent page (`/dashboard/ledger`,
`/dashboard/reports`, `/dashboard/inventory`'s costing surfaces, `/dashboard/jewelry`, the setup
wizard's `/setup/accounts` and `/setup/tax` steps) against professional Persian accounting
terminology has not been done. This is real, scoped work — not a rewrite, a review-and-relabel pass
— and per #160's own added requirement (comment, §9), it needs to happen **before every future wave's
PR**, not just once. Recommendation: fold it into Wave 2 as a one-time baseline pass, then treat it as
a standing checklist item on every subsequent wave (see §8).

## 4. Cafe/restaurant specialized accounting (#160 §4)

| Item | Status |
|---|---|
| فروش غذا / فروش نوشیدنی | **Exists in COA, not wired** — 4100/4200 are template rows but auto-posting sends every order to the general `salesRevenue` (4300) account; no `menu_categories` → account mapping exists (an explicit Phase 7 decision, revisited and left as-is — "Order revenue split" note in Phase 7 doc) |
| فروش بیرون‌بر (takeout) / ارسال (delivery) / پلتفرم‌های سفارش آنلاین (delivery platforms) / کمیسیون پلتفرم‌ها (platform commissions) | **Gap** | Phase 11 (Delivery) tracks couriers/delivery orders operationally, but nothing in the COA or posting rules splits delivery revenue from dine-in, and there is no platform-commission expense account or posting path at all |
| کارت‌خوان و تسویه‌ها (card settlement) | **Exists** | `bankClearing` (1120) |
| صندوق و شیفت (cash register & shift) | **Exists operationally** (Phase 4/5 `shift-service.ts`) **and reconciles to the ledger** (Phase 16 bank/cash reconciliation against `cash`/`bankClearing`). One caveat carried over from migration 0008's own comment: `v_shift_reconciliation` is a proxy built off order/payment data — there's no dedicated till/clock-in/clock-out entity backing it |
| انعام کارکنان (staff tips) | **Gap** | No tip field on an order, no tip liability/expense account. Confirmed by search — no tip concept anywhere in `src/lib` |
| مواد اولیه / دستور تولید (recipe costing) | **Exists** | Phase 6 `menu_item_ingredients`, recipe-based COGS |
| ضایعات (waste) | **Exists** | `wasteExpense` (5150), full posting path |
| کسری موجودی (inventory shortage) | **Exists** | `inventoryCountExpense` (5160), negative-layer shortage tracking |
| بهای تمام‌شده غذا / کنترل Food Cost | **Partial** | COGS is tracked exactly (FIFO/weighted-average); no dedicated "food cost %" report comparing actual vs. theoretical/recipe-standard consumption |
| کنترل مصرف واقعی و استاندارد (actual vs. standard consumption) | **Gap** | No variance report exists comparing recipe-standard ingredient usage to actual deducted stock |
| هزینه کارکنان / انرژی / اجاره / بازاریابی | **Exists** | 5200/5300/5400/5600 in the COA, postable via manual journal or (payroll) via `payroll-service.ts` |

**Wave 1 conclusion for §4:** the biggest real gaps are (a) revenue not split by sales channel
(dine-in/takeout/delivery/online-platform) or category, (b) no platform-commission or tip accounts,
and (c) no actual-vs-standard food-cost variance report. These map cleanly onto a "cafe/restaurant COA
depth" wave (see §8, Wave 4) — a template and posting-rule extension, not new core-engine work, since
Phase 21's posting-rule engine already exists to hang these on.

## 5. Jewelry/gold/watch/accessories accounting (#160 §5)

Already delivered by **Phase 21, Waves 1-4** (see §0 above): weight/purity, daily gold pricing,
making-charge/profit/VAT formula, stone cost add-ons, consignment posting with its own liability/
commission accounts, `/api/jewelry/*` + `/dashboard/jewelry`, and jewelry selectable at `/welcome`.

Remaining, already scoped as **Phase 21 Waves 5-7** (not yet built):

- Watch: serialized units, warranty, repair-ticket workflow (Phase 21 Wave 5)
- Accessories: variant management UI (Phase 21 Wave 6 — thin, since the variant primitive already
  exists from Wave 1)
- Specialized reports: weight reconciliation, consignment statements, warranty/repair reports,
  variant-level sales analysis, item-level audit trail (Phase 21 Wave 7)

Also explicitly still open per Phase 21's own doc: an external gold-price feed (provider TBD, hook
exists), paying out a consignor's payable balance + consignor statements, and weight-based FIFO lots
for bulk gold stock (today's `unit_cost_per_gram` is an average-cost simplification).

**Wave 1 recommendation:** #160's proposed "Wave 5: jewelry template" and "Wave 6: multi-industry
architecture" should not be re-run — they're Phase 21 Waves 1-4, done. #160's remaining industry work
is exactly Phase 21's own remaining Waves 5-7, which should continue under Phase 21's tracking rather
than being duplicated under #160. #160's real net-new contribution to this area is the terminology/
UX audit (§9) applied to the jewelry UI specifically, which Phase 21 never had as an explicit goal.

## 6. Multi-industry architecture (#160 §6)

Already delivered by **Phase 21 Wave 1**: `businesses.industry` (immutable, checked, defaulted),
domain-event log + posting-rule engine (`src/lib/posting-engine.ts`, `registerPostingRule`/
`emitDomainEvent`/`dispatchDomainEvent`), generic Item/Variant/Serial primitive
(`items`/`item_variant_attributes`/`item_serials`), industry-aware setup wizard
(`wizard-steps.ts`'s `wizardStepsForIndustry`).

**Gap:** the posting engine is proven (F&B waste posting rewired through it, jewelry's gold-sale rules
built directly against it) but most of F&B's own posting functions (order payment, COGS, purchases,
stock counts, AR/AP, payroll, expenses, closing) are still hand-written functions in
`ledger-service.ts`, deliberately not migrated onto the engine yet (a considered decision in Phase 21,
not an oversight — see its Wave 1 progress notes). This is fine as-is for two industries; if #160's
"Rules Engine" ask (§6) means every posting path should eventually be a registered rule, that's a
larger, lower-priority refactor with no product need behind it yet — flagged here, not recommended
for near-term scheduling.

## 7. Software changes needed (#160 §7) — the concrete Core Accounting Engine backlog

This is where §1/§2's metadata gaps turn into an actual implementation list for Wave 2:

### 7.1 Account hierarchy levels (گروه / کل / معین / تفصیلی)

`accounts` (migration 0001) has only `code`, `name`, `type`, `parent_id`, `is_active` — arbitrary
nesting depth via `parent_id`, no concept of which of the four standard Iranian-accounting levels a
given account sits at. Needed: an explicit `level` enum (`group` | `kol` | `moein` | `tafsili`) or
equivalent, validated so a `tafsili` account can't parent another `tafsili` account, etc. This is a
schema addition (new column + migration) plus updates to `accounts-service.ts`'s create/reparent
validation and the COA templates (`coa-template.ts`) to tag every existing row with its level.
Backward-compatible: existing `parent_id` nesting already roughly follows this shape (e.g. `1000` →
`1100` in `FNB_COA_TEMPLATE` is already a group→kol relationship), so this is largely a labeling
migration, not a restructuring one.

### 7.2 Account nature/behavior (Account Nature, Account Behavior, contra accounts)

Needed: an explicit, stored `normal_balance` (`debit` | `credit`) derived from `type` at creation
(asset/expense → debit, liability/equity/revenue → credit) but stored rather than re-derived ad hoc
in report code each time, plus an `is_contra` boolean for accounts like `salesReturns`/`nrvAllowance`
whose balance moves opposite their type's normal direction. This closes the "Account Metadata /
Account Nature / Account Behavior" item in §7's own list and lets reports (and the UI) show a
correct ↑/↓ or بدهکار/بستانکار badge per account without re-deriving it from `type` inline every time.

### 7.3 دفتر کل / دفتر معین / گردش حساب reporting

The underlying data (`getAccountDrillDown`, journal lines by account) already supports these; what's
missing is presenting them as their own named reports rather than only as a drill-down overlay on
top of P&L/Balance Sheet/trial-balance figures. Concretely: a per-account statement page (opening
balance, every movement in a date range, running balance, closing balance) reachable directly from
the chart-of-accounts tab, not only by clicking through a report line.

### 7.4 System-account labeling in the UI

`WELL_KNOWN_CODES` protection already exists at the service layer; the chart-of-accounts UI should
visibly badge a well-known account as "حساب سیستمی" wherever archive/delete is offered, rather than
only reactively rejecting the action.

### 7.5 Posting Rules / Validation / Audit Trail / Permission Control

- **Posting rules**: exists as the Phase 21 posting-rule engine for new (event-driven) postings;
  legacy F&B posting functions are hand-validated in `ledger-service.ts`/`ledger.ts`
  (`validateJournalLines`/`checkBalance`) — sufficient, no gap.
- **Journal Entry Engine**: exists (`postJournalEntry`/`postExactJournalEntry`).
- **Audit Trail**: `journal_entries.created_by`/`posted_at` exist; reversal linkage
  (`reverses_entry_id`/`reversed_at`/`reversed_by`) exists (Phase 16). No gap for the ledger itself.
  Whether a broader cross-module audit trail (who changed an account's name, who archived it) is
  wanted is a §7 open question worth confirming with the product owner before scheduling — `accounts`
  has no history table today, only current state.
- **Permission Control**: exists and is granular (`PERMISSIONS.ledgerApprove`, `accountsEdit`,
  role gating throughout Phase 16). No gap.

## 8. Recommended wave sequencing (revises #160 §8)

Given the audit above, re-sequencing #160's own 7-wave plan to avoid redoing Phase 21's shipped work
and to order the real gaps by dependency:

1. **Wave 1 (this document)** — audit + gap analysis. Done.
2. **Wave 2 — Core Accounting Engine metadata.** §7.1 (account levels), §7.2 (nature/contra flags),
   §7.4 (system-account UI badge). Schema-additive, no behavior change to existing postings — the
   lowest-risk, foundational wave, and a prerequisite for Wave 3's terminology pass having something
   correct to label.
3. **Wave 3 — Terminology & UI/UX standards audit (closes #160 §3 and §9).** A full label-by-label
   pass across every accounting-adjacent page, using the vocabulary Wave 2 makes available (level
   names, nature). Establishes the baseline; #160's own §9 requirement ("before every future wave's
   PR") then applies going forward as a checklist, not a one-time deliverable.
4. **Wave 4 — Cafe/restaurant COA depth (closes #160 §4's remaining gaps).** Revenue split by channel
   (dine-in/takeout/delivery/platform) and category, platform-commission and tip accounts + posting
   rules (built as registered rules against Phase 21's posting engine, not new hand-written
   `ledger-service.ts` functions), and an actual-vs-standard food-cost variance report.
5. **Wave 5 — دفتر کل/معین/گردش حساب reporting (closes §7.3), fixed assets & depreciation (closes
   the §2 gap).** Two independent, reporting-and-schema-additive slices; can run as one wave or split
   if either grows large enough to warrant its own PR.
6. **Continue Phase 21 Waves 5-7** (watch, accessories, specialized industry reports) under Phase
   21's own tracking — not duplicated as a new #160 wave, per §5/§6 above.
7. **Regression/migration/documentation pass** — once Waves 2-5 land, re-run the full suite
   (`npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build`), confirm `tenant-isolation`
   picks up any new tables automatically, and update this phase doc's "Progress" section per the
   project's normal phase-doc convention.

Each wave still gets its own PR, its own full local test run before that PR, and (per #160's added
§9 requirement) its own terminology/UI review before being called done — exactly as #160's "قوانین
اجرا" (execution rules) require.

## Exit criteria (for Wave 1 specifically)

- [x] Every #160 scope item (§1-§7) mapped to either "exists" (with file/line evidence), "partial gap",
  or "gap".
- [x] Every apparent gap checked against Phase 21's own documented roadmap first, to avoid
  double-counting already-planned work as new #160 scope.
- [x] A concrete, dependency-ordered backlog for Waves 2+ that a future PR can pick up directly
  without re-deriving this analysis.

## Open questions for the product owner (carried into Wave 2+)

1. §7.1's account-level model: is the 4-tier گروه/کل/معین/تفصیلی distinction needed as enforced
   structure (a `tafsili` account literally cannot parent another `tafsili`), or as descriptive
   metadata only (a label with no new constraint)? **Answered by Wave 2 (below): enforced structure**
   — the same discipline every other invariant in this codebase uses (reject at the boundary, don't
   just describe).
2. §4's revenue-channel split: should dine-in/takeout/delivery/platform revenue split be per-order
   (requires an order-level channel field, which may already partially exist via Phase 11's delivery
   flag — needs confirming) or is a coarser split acceptable for v1?
3. §7.5's audit-trail question: is a full change-history table for `accounts` (who renamed/archived/
   reparented, and when) in scope, or is current-state-only sufficient?

## Progress

**Wave 1 — audit & gap analysis — implemented.** This document, as originally written (sections
0-8 above). No code changes.

**Wave 2 — Core Accounting Engine metadata — implemented**, covering §7.1 (account hierarchy
levels), §7.2 (debit/credit nature + contra flag), and §7.4 (system-account UI badge):

- **Account levels (گروه/کل/معین/تفصیلی)** — `migrations/0056_account_hierarchy_nature.sql` adds
  `accounts.level` (a new `account_level` enum), backfilled for every existing account by actual
  parent-chain depth (a recursive CTE, not a flat "root vs. everything else" guess). `coa-template.ts`
  gained `AccountLevel`, `nextAccountLevel(parentLevel)` (the pure level-transition rule: `null` →
  `group`, `group` → `kol` → `moein` → `tafsili`, and `null` past `tafsili` — a تفصیلی account can't
  have children), and `ACCOUNT_LEVEL_LABELS`. Enforced, not just descriptive (resolving open question
  1 above): `accounts-service.ts`'s `createAccount`/`reparentAccount` both compute the correct level
  from the chosen parent and reject with `parent_too_deep` if the parent is already `tafsili`;
  `reparentAccount` also cascades the new level down every existing descendant
  (`cascadeDescendantLevels`, a BFS walk in the same transaction) and rejects the whole move with
  `hierarchy_too_deep` if any descendant would need to sit past `tafsili`. The three chart-of-accounts
  seeding/replace call sites (`business-provisioning.ts`'s `seedChartOfAccounts`, `/api/setup/accounts`
  POST, `/api/settings/accounts` PUT) compute each row's level the same way, in the same parent-first
  topological insertion order they already used.
- **Debit/credit nature (ماهیت بدهکار/بستانکار)** — `accounts.normal_balance` is a `GENERATED ALWAYS
  AS (...) STORED` column derived directly from `type` (asset/expense → debit, liability/equity/
  revenue → credit), not a value any code path sets — this guarantees it's always correct for every
  insertion path, including the dozens of raw-SQL account fixtures across the existing test suite,
  with no code changes required anywhere else and no risk of drifting from `type`. `coa-template.ts`
  gained `normalBalanceForType(type)`, the same mapping the generated column encodes in SQL, exposed
  for display/reporting code.
- **Contra accounts (حساب‌های کاهنده)** — `accounts.is_contra` (plain boolean, default `false`).
  `TemplateAccount` gained an optional `isContra` field; the F&B template's «برگشت از فروش» (4400) and
  «ذخیره کاهش ارزش موجودی» (1390) are marked `isContra: true` (backfilled onto every existing business
  by the same migration, matched by code — the same pattern migrations 0025/0032 used). `createAccount`
  accepts an optional `isContra` param for ad hoc sub-accounts.
- **System-account badge (§7.4)** — `chart-of-accounts-section.tsx` now shows a level column, a
  ماهیت column (بدهکار/بستانکار, with a «(کاهنده)» suffix for a contra account), and a «سیستمی» badge
  next to any account whose code is in `WELL_KNOWN_CODES` — previously this protection only surfaced
  reactively, as an error message when an archive/delete was rejected. The add-account form gained a
  «حساب کاهنده» checkbox and shows each candidate parent's level in its picker.
- **A pre-existing bug this wave's own migration exposed, fixed alongside**: `tenant-export.ts`'s
  `exportTenantData` built its per-table column list from `SELECT *`, which includes generated
  columns — Postgres refuses an explicit `INSERT` into one, so the moment `accounts` gained a
  generated `normal_balance` column, every per-business SQL backup/restore round-trip involving an
  account broke (`integration/tenant-export.integration.test.ts` caught this immediately). Fixed
  generically, not with an `accounts`-specific special case: `exportTenantData` now reads
  `information_schema.columns.is_generated` once per export and excludes any generated column from
  the table's column list — correct for `accounts.normal_balance` today and for any future generated
  column on any table, with no per-table maintenance needed.
- Verified in `src/lib/coa-template.test.ts` (`nextAccountLevel`'s four transitions plus the
  past-تفصیلی `null` case, `normalBalanceForType`'s full mapping, and that exactly the two intended
  F&B accounts are marked contra) and extended `integration/chart-of-accounts.integration.test.ts`
  (a four-level create chain assigns group/kol/moein/tafsili correctly; creating a child under a
  تفصیلی account is rejected; reparenting cascades the new level through a multi-level subtree;
  reparenting that would push a descendant past تفصیلی is rejected and rolled back; clearing an
  account's parent resets it and its descendants back down; normal balance is stored correctly for
  all five account types; an explicit `isContra` flag persists and defaults to `false`). `npx tsc
  --noEmit`, `npm test` (951 tests, up from 943), `npm run db:migrate` (twice, confirmed a no-op the
  second time) + `npm run test:db` (310 tests, `tenant-isolation`'s 19 tests re-confirming RLS
  unaffected by the new columns), and `npm run build` all pass.

Not yet built (left for a later wave, not blocking Wave 2's own exit): §3/§9's full terminology/UI-UX
audit (Wave 3 in the recommended sequencing above), §7.3's dedicated دفتر معین/گردش حساب statement
page, §4's cafe/restaurant COA depth (revenue-channel split, platform-commission/tip accounts,
food-cost variance report), and §2's fixed-asset/depreciation gap. The setup-wizard step
(`/setup/accounts`) and the settings-page chart editor (`accounts-settings.tsx`) don't yet expose the
`isContra` checkbox the way the ledger's ongoing chart-of-accounts management tab does — intentional
for this slice (those two are one-time/bulk template editors; `isContra` defaults to `false` and stays
editable afterward through the ledger tab), flagged here in case a future wave decides otherwise.

**Wave 3 — Terminology & UI/UX standards audit — implemented**, closing §3 and the epic's §9
requirement: a label-by-label pass across every accounting-adjacent dashboard page
(`/dashboard/ledger` except the already-correct `chart-of-accounts-section.tsx`, `/dashboard/reports`,
`/dashboard/jewelry`, the costing-adjacent parts of `/dashboard/inventory`, `/setup/accounts`,
`/setup/tax`, `src/app/dashboard/settings/accounts-settings.tsx`). Result: the vocabulary was already
correct and consistent almost everywhere (سند/دفتر روزنامه/تراز آزمایشی/تأیید/بدهکار-بستانکار/
حساب‌های دریافتنی-پرداختنی/صورت گردش وجوه نقد all checked across every file they appear in and found
consistent) — the one real inconsistency found was the «equity» account-type label: `chart-of-
accounts-section.tsx` and `trial-balance-section.tsx` already said «حقوق صاحبان سرمایه», but
`accounts-settings.tsx` said «حقوق مالکانه» and `setup/accounts/page.tsx` said «سرمایه». Both fixed to
match. New `docs/accounting-terminology.md` records the standard-term reference table and the
terminology-validation checklist §9 asks every future wave's PR to run before opening.
No component logic, prop names, function signatures, API contracts, or `coa-template.ts` account
names/codes were touched — string-literal label changes only. `npx tsc --noEmit`, `npm test` (951
tests, unchanged — no test-affecting code changed), `npm run test:db` (310 tests), and `npm run
build` all pass.
