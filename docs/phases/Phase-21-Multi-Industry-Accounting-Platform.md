# Phase 21 — Multi-Industry Accounting Platform Expansion (Jewelry, Watch & Accessories)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 6 (inventory/costing), Phase 7 (double-entry ledger), Phase 12 (tenancy), Phase 15/17
(feature flags, plans), Phase 16 (accounting suite — AR/AP/manual-journal patterns this phase reuses)
**Tracks:** GitHub issue [#109](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/109)
**Goal:** Turn a single-industry (food & beverage) POS into a multi-industry accounting platform —
Core Accounting + Industry Modules — starting with gold/jewelry, watch, and accessories (bijoux),
without changing observable behavior for an existing F&B business.

---

## Why this is its own phase, not a slice of an existing one

Every phase so far has extended one business shape: a café/restaurant that sells menu items made
from recipes, seats guests at tables, and sends tickets to a kitchen. Nothing in the schema
discriminates *what kind* of business a tenant is — `businesses` has no type column at all. Gold,
watch, and accessories retail aren't new features of that shape; they're a different shape:
items that sell by weight and daily price instead of a fixed menu price, serialized units instead
of recipe-consumed ingredients, variant matrices instead of modifier groups. Reusing Core
Accounting (ledger, COA, fiscal periods, AR/AP, manual journals — all built and proven in Phases
7/16) while adding that different shape is the actual engineering problem this phase solves.

## Architecture principles (from the issue, made concrete)

- **Don't break existing POS/restaurant behavior.** Every existing integration/unit test keeps
  passing unmodified; F&B behavior is the regression baseline for the whole phase, not just a
  reminder.
- **Industry logic is separated from the accounting core** via a real **domain-event log + posting
  engine** (Wave 1) — replacing today's per-event posting functions (`postOrderPaymentEntry`,
  `postCogsEntry`, `postPurchaseEntry`, `postWasteEntry`, …, each hand-written in
  `ledger-service.ts`/`inventory-service.ts`). A new industry's posting rules become a
  registration against the engine, not a new copy of ledger code.
- **Capability-based.** `businesses.industry` is the new top-level discriminator; the existing
  `feature_flags`/`business_features`/`plans` system (Phase 15/17) becomes industry-aware rather
  than being replaced — see `src/lib/features.ts`'s `API_FEATURE_PREFIXES`/`PAGE_FEATURE_PREFIXES`,
  which this phase extends, not forks.
- **Domain events + posting engine**, one central mechanism, per above.
- **Full tenant isolation.** Every new table gets an RLS policy in the same migration that creates
  it, per the project-wide rule; `integration/tenant-isolation.integration.test.ts` covers new
  tables automatically once they exist.

## Scope decision: what "generalize" means here

Brainstormed and decided with the product owner before Wave 1 starts: **generalize the sellable-item
and posting core, not the dine-in service workflow.** Concretely:

- `menu_items` + `inventory_items` + `recipes`/`menu_item_ingredients` are unified behind one
  generic item model (item, optional variant axes, optional serial units, optional weight/purity
  attributes) that F&B, gold/jewelry, watch, and accessories all read through. F&B's own behavior
  (menu grid, recipe-based deduction, FIFO/weighted-average costing) must come out the other side
  byte-for-byte identical — this is an internal refactor proven by the existing test suite, not a
  product change.
- **Tables, floor plans, waiter app, kitchen display, and reservations stay F&B-specific**,
  already gated behind the `reservations` feature flag (Phase 17) — nothing in gold/watch/
  accessories retail has an equivalent concept, and generalizing them would be speculative,
  not something any of the three target industries need. They're simply not offered to a
  non-food-service business.
- The domain-event/posting-engine refactor (Wave 1) is where F&B's existing posting functions
  get re-expressed as registered rules against the new engine — same resulting journal entries,
  different internal plumbing.

## Waves

Same seven waves as the issue, resequenced so the genuinely shared primitive (item/variant/serial)
is built once in Wave 1 instead of separately in Waves 2, 5, and 6:

1. **Wave 1 — Multi-industry core.** `businesses.industry` (immutable after setup, like the
   costing-method lock); domain-event log (`domain_events`: `business_id`, `event_type`, `payload
   jsonb`, `source_type`/`source_id`) + posting-rule engine industry modules register against;
   generic Item/Variant/Serial primitive that `menu_items`/`inventory_items`/`recipes` are migrated
   onto (F&B behavior unchanged, proven by the existing suite); industry-aware setup wizard
   (Wizard step 1 picks the industry; each industry gets its own COA seed template and its own
   remaining wizard steps — F&B's 8-step wizard is one instance of this, not special-cased code).
2. **Wave 2 — Weighted goods & gold inventory.** Fractional-weight quantities (grams, a new
   numeric-precision convention alongside integer-Rial money and the existing item primitive),
   purity/karat attributes, weight-based lots and stock counts, daily gold-price entry
   (per gram, per purity) — manual entry as the baseline, with an optional per-business external
   price-feed integration (configurable, not required).
3. **Wave 3 — Gold pricing engine & specialized sales.** The price formula (weight × purity-
   adjusted price/gram + اجرت [making charge, % or fixed] + profit % + VAT), a transparent
   receipt/POS breakdown of each component, and posting through Wave 1's engine.
4. **Wave 4 — Jewelry, stones & consignment.** Gem/stone attributes as cost add-ons on an item;
   consignment (امانی) as a subledger mirroring Phase 16's AR/AP pattern — held off the business's
   own balance sheet until sold, then a commission/settlement posting to the consignor.
5. **Wave 5 — Watch: serial, warranty, repairs.** Serialized units (one row per physical item,
   using Wave 1's serial primitive, not lot/weight averaging); warranty terms starting at sale;
   a repair/service ticket workflow (intake → parts consumed from inventory → labor cost → close).
6. **Wave 6 — Accessories & variant management.** Mostly UI and accessory-specific configuration
   on top of Wave 1's variant primitive — deliberately thin because the shared model already
   exists by this point.
7. **Wave 7 — Specialized reports & audit controls.** Weight reconciliation (physical scale count
   vs. system, in grams — the weight-based analogue of Phase 6's stock counts), consignment
   statements, warranty/repair reports, variant-level sales analysis, and an item-level audit trail
   for high-value serialized/weighed goods.

Each wave is still developed, tested, and PR'd independently, per the issue's own rule.

## Out of scope (for this phase)

- A business running more than one industry at once (v1: one `industry` per business, chosen once
  at setup, same lock pattern as inventory costing).
- Generalizing tables/floor/waiter/kitchen/reservations — not needed by any of the three target
  industries (see scope decision above).
- Iranian statutory e-invoicing/گارانتی-registry integrations for watches, or any real-time
  external gold-price provider selection — the *hook* for an external feed is in scope (Wave 2),
  picking and contracting a specific provider is not.
- A generic plugin SDK for third-party industry modules — three named industries, built in-repo,
  not an extensibility platform for arbitrary future ones (revisit if a fourth industry is ever
  requested).

## Exit criteria

- An existing F&B business shows zero behavioral change: every current integration/unit test
  passes unmodified, and a manual pass through setup → POS → kitchen → ledger looks identical.
- A new business can pick "gold/jewelry", "watch", or "accessories" at setup and get that
  industry's own item model, pricing/sales flow, and chart of accounts — with no F&B-only nav
  (menu, tables, waiter, kitchen, reservations) visible.
- A gold sale's receipt shows the full price breakdown (weight, purity-adjusted price/gram,
  making charge, profit %, VAT) and posts a balanced journal entry via the posting engine.
- A consignment item never appears in the business's own inventory valuation until sold, and
  selling it posts the correct commission/settlement split.
- A watch's serial number, warranty window, and repair history are all queryable from one item
  record, and a repair ticket's parts/labor post correctly to the ledger.
- Every new table has an RLS policy and is covered by the generated tenant-isolation test.

## Open questions

1. **Generic item schema shape** — one wide table with nullable industry-specific columns, or a
   core `items` table plus one satellite table per capability (weight, serial, variant)? Leaning
   satellite tables (matches how `menu_item_ingredients`/`modifier_ingredients` already extend
   `menu_items` today), to be settled at the start of Wave 1.
2. **Weight precision & rounding** — grams to how many decimal places, and what rounding rule at
   the point a computed price meets integer-Rial storage? Needs a real decision before Wave 2's
   migration, the same way Phase 0 fixed integer-Rial for money.
3. **External gold-price feed** — provider TBD; Wave 2 builds the pluggable hook and ships manual
   entry, a specific integration is a follow-up once a provider is chosen.
4. **Consignment settlement accounts** — new well-known accounts (a consignment-liability account
   distinct from Accounts Payable?) — to be designed alongside Wave 4, following Phase 16's
   pattern of adding well-known codes plus a backfill migration.
5. **Repair ticket workflow detail** (statuses, whether it reuses the kitchen-ticket state-machine
   shape or needs its own) — deferred to Wave 5 design.
6. **Can an existing F&B business ever switch industry later**, or is the setup-time choice as
   permanent as the costing-method lock? Leaning permanent for v1 (same reasoning as costing
   method — changing it retroactively would corrupt historical postings), revisit only if asked.

## Progress

Wave 1, first slice — implemented:

- **`businesses.industry`** (`migrations/0048_business_industry.sql`) — a `CHECK`-constrained text
  column (`food_service`/`jewelry`/`watch`/`accessories`), defaulted (and backfilled) to
  `food_service` for every existing business. Set once, at creation, in `provisionBusiness`
  (`src/lib/business-provisioning.ts`) — no update route exists, so it is immutable by omission
  rather than needing a separate lock flag the way inventory costing does. `src/lib/industries.ts`
  is the framework-free shared source of truth (the type, the full list, and which are actually
  offered) so both the server-side validator and the `/welcome` bootstrap UI import the same
  constants. Only `food_service` is in `ENABLED_INDUSTRIES` — the other three are selectable in the
  type system and rejected (`industry_not_available`) at the API if forced, and shown disabled with
  a "به‌زودی" badge in the UI, until their own wave lands a chart-of-accounts template and wizard
  steps. `resetBusiness` (`platform-service.ts`) was fixed to preserve `industry` across a
  platform-console reset — it re-inserts the business row from a pre-delete snapshot, and would
  otherwise have silently dropped a business back to the `food_service` default. Verified in
  `business-provisioning.test.ts` (default/accept/reject cases) and manually end-to-end (Playwright
  against a running dev server: submitted the `/welcome` form, confirmed the industry selector
  renders with only `food_service` enabled, and confirmed the created row's `industry` column).
- **Domain-event log + posting-rule engine** (`migrations/0049_domain_events.sql`,
  `src/lib/posting-engine.ts`) — `domain_events` records a business event generically
  (`event_type`, a jsonb `payload`, optional `source_type`/`source_id`); `registerPostingRule`
  lets a module teach the engine how to turn one event type into a balanced journal entry via the
  existing `postJournalEntry()`, and `emitDomainEvent`/`dispatchDomainEvent` record-then-post in
  the caller's own transaction, stamping `domain_events.entry_id` on success. An event with no
  registered rule, or a rule that returns `null`, is recorded but deliberately left unposted — not
  an error, since not every domain event has a ledger effect. Deliberately **not** wired to any of
  F&B's existing posting paths yet (`postOrderPaymentEntry` etc. are untouched) — that rewiring is
  its own follow-up slice, once this engine has shipped and proven out on its own. Verified in
  `integration/posting-engine.integration.test.ts` (posts and stamps `entry_id`, leaves an
  unregistered event type unposted, a rule returning `null` posts nothing, an unbalanced rule's
  lines are rejected exactly like every other posting path, and re-registering an event type
  replaces the previous rule).
- **Generic Item/Variant/Serial primitive** (`migrations/0050_generic_item_core.sql`,
  `src/lib/items.ts` + `src/lib/items-service.ts`) — a new, parallel `items` table
  (`kind`: simple/variant_parent/variant_child, `tracking`: none/serial/weight),
  `item_variant_attributes` (one row per distinguishing attribute on a variant child — Wave 6's
  accessories will build on this), and `item_serials` (one row per physical unit of a
  `tracking: 'serial'` item — Wave 5's watches). Weight/purity attributes are deliberately **not**
  part of this table set — that's Wave 2's job, once fractional-weight precision/rounding is
  actually decided rather than guessed at here. Deliberately **not** linked from
  `menu_items`/`inventory_items`/`recipes` yet — migrating F&B's own model onto this primitive
  without changing its observable behavior is its own follow-up slice, not bundled into the
  primitive's introduction. Verified in `integration/generic-items.integration.test.ts` (simple
  item creation, variant parent/child creation with attributes — including the all-or-nothing
  failure case leaving no orphan row — and serial registration/status lifecycle, including that a
  `sold` unit can never move to another status and a duplicate serial number is rejected) and
  `src/lib/items.test.ts` (the pure validation rules these lean on).
- All four new tables (`domain_events`, `items`, `item_variant_attributes`, `item_serials`) are
  automatically covered by `integration/tenant-isolation.integration.test.ts`'s generated
  policy-correctness check and `tenant-tables.ts`'s export/restore enumeration — both discover
  tables from `pg_class` rather than a hand-maintained list, so nothing needed updating there;
  re-ran both suites to confirm.

Remaining Wave 1 work (tracked as this phase's next slice, not started yet): migrating
`menu_items`/`inventory_items`/`recipes` onto the generic item primitive with F&B's observable
behavior proven unchanged, and the industry-specific setup-wizard branches (chart-of-accounts
template + remaining steps) for `jewelry`/`watch`/`accessories` once their own waves need them.

Wave 1, second slice — the posting engine's first real (non-test) wiring — implemented:

- **The engine now uses exact (RialText/BigInt) arithmetic, not plain-number `Rial`.** Auditing
  F&B's actual live posting surface (as opposed to the Phase 7 doc's original description) turned
  up that every inventory-costing-sensitive posting path — order payment, COGS, purchases, waste,
  stock counts, customer refunds — was already rebuilt at some point onto a private
  `postExactJournalEntry`/`RialText`/`Decimal`-based path (`ledger-service.ts`), superseding the
  original plain-`number` `postJournalEntry` for those cases specifically (non-costing postings —
  manual journals, AR/AP collection, payroll, expenses, closing entries — still correctly use the
  plain-number path, since they never multiply a fractional quantity by a unit cost). The engine
  as first shipped only knew about the plain-number path, which would have been the wrong
  foundation for Wave 2's weight × price/gram gold-pricing math. Fixed by exporting
  `postExactJournalEntry`/`ExactJournalLine` and switching `dispatchDomainEvent` to post through
  them; `PostingResult` also gained `postingKind`/`inventoryEventId`, the two report/reconciliation
  and inventory-traceability fields every existing exact posting path already carries and the
  engine had no way to pass through before.
- **`PostingRule` now receives the transaction's `PoolClient`, not just the event.** The original
  signature (`(event) => ...`) had no way for a rule to call `accountIdsByCode` — real posting
  logic needs to resolve account codes to ids inside the same transaction, so this was a real gap
  that only surfaced once a real rule was written against it, not a hypothetical one.
- **`src/lib/fnb-posting-rules.ts`** registers `inventory.operational_posting` — a generic
  Debit/Credit-one-amount rule mirroring `postExactOperationalInventoryEntry`'s own parametrised
  shape exactly. `src/app/api/inventory/waste/route.ts` (the only real caller of
  `postExactOperationalInventoryEntry`) now emits this event through the engine instead of calling
  that function directly. `postExactOperationalInventoryEntry` itself is completely unchanged and
  still directly covered by `integration/exact-operational-consumption.integration.test.ts` — nothing
  about its own behavior or callers-other-than-the-waste-route changed. The rest of F&B's posting
  functions (order payment, COGS, purchases, stock counts, AR/AP, payroll, expenses, manual
  journals, closing) are deliberately **not** migrated in this slice — they're proven and
  load-bearing, and there is no product need to move them onto this engine until a reason to
  (e.g. sharing logic with a new industry) actually shows up; forcing all of them through a new
  abstraction in one slice, with no new industry yet live to justify it, would have been risk
  without value.
- Verified in `integration/posting-engine.integration.test.ts` (extended: exact-arithmetic lines,
  a rule using the injected client to call `accountIdsByCode`, and `postingKind`/`inventoryEventId`
  stamping through to the posted entry) and a new
  `integration/fnb-posting-rules.integration.test.ts` (the registered rule reproduces the same
  balanced entry `postExactOperationalInventoryEntry` would for identical inputs — proving the two
  paths agree, not just asserting it). The full existing suite (899 unit tests, 273 integration
  tests including `exact-operational-consumption`) stayed green throughout. Manually verified
  end-to-end against a running server: seeded a business, gave an inventory item a real cost basis
  via a purchase, posted a waste entry through `/api/inventory/waste`, and confirmed — same API
  response shape as before, a `domain_events` row recorded and stamped `entry_id`, and the exact
  expected journal entry (Debit «ضایعات مواد» 5150 / Credit «موجودی مواد و کالا» 1300, correct
  amount, `posting_kind = 'waste'`).
