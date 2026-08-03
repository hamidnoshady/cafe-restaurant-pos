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

Brainstormed and decided with the product owner before Wave 1 started: generalize the *posting*
core, not the item/inventory data model. This revises the phase's original brainstorm decision
(quoted below for the record) once building Wave 1 surfaced why unifying the item model isn't the
right call — see "Revised: `menu_items`/`inventory_items` are not migrated" just below.

Concretely:

- **The posting core generalizes** via the domain-event log + posting engine (see the architecture
  principle above) — proven end-to-end by wiring F&B's own waste posting through it. This is the
  part of "Core Accounting + Industry Modules" that actually needed to be shared, and it is.
- **Tables, floor plans, waiter app, kitchen display, and reservations stay F&B-specific**,
  already gated behind the `reservations` feature flag (Phase 17) — nothing in gold/watch/
  accessories retail has an equivalent concept, and generalizing them would be speculative,
  not something any of the three target industries need. They're simply not offered to a
  non-food-service business.
- The domain-event/posting-engine refactor (Wave 1) is where F&B's existing posting functions
  get re-expressed as registered rules against the new engine — same resulting journal entries,
  different internal plumbing. (In practice only one path, waste, has actually been re-expressed
  so far — see the Wave 1 progress notes below for why the rest are deliberately left alone.)

### Revised: `menu_items`/`inventory_items` are not migrated onto the generic item model

The phase's original brainstorm decision (recorded above the line for the historical record) called
for unifying `menu_items`/`inventory_items`/recipes onto the new generic Item/Variant/Serial
primitive, with F&B's behavior proven unchanged. Building Wave 1 far enough to actually attempt this
surfaced a fact the brainstorm didn't have: **`inventory_items` is not a thin catalog table** — it is
the anchor of five-plus phases (6, 12, 13, 15, 17, 19) of hardened, exact-arithmetic costing
machinery (FIFO lots, weighted-average, negative-layer shortage tracking, NRV write-downs, transfers,
cutover, purchase-receipt settlement), all built with `SELECT ... FOR UPDATE` row locking directly
against its own columns (`avg_cost`, `carrying_value_rial`, `purchase_unit_factor`, …) across roughly
seven `src/lib/*.ts` files. The new `items` table (migration 0050) deliberately carries none of that —
correctly so, since a jewelry piece's cost (weight × daily price/gram) has nothing in common with
FIFO lot consumption, and baking F&B-specific costing columns into a table meant to also serve
gold/watch/accessories would be exactly the kind of premature, wrong-shaped generalization the
project avoids elsewhere.

There is a genuinely favorable seam in the costing chain — `order_item_inventory_snapshots
.inventory_item_id` is the only handle any costing code needs downstream of order capture; nothing
downstream ever re-reads `menu_items`/`modifiers` — but that seam is about decoupling a sale from its
recipe at capture time, not about `inventory_items` itself being swappable. Actually migrating it
onto `items` would mean either bloating the generic model with F&B-only costing columns, or building
a second, parallel costing engine against a different table — duplicating ~7 already-hardened files'
worth of exact-arithmetic logic — for no industry that has shipped yet and needs to share it. That is
risk with no offsetting product value, the same lesson the posting-engine slice already taught at
smaller scale (see decision below).

**Decision (confirmed with the product owner, reversing the earlier call): `menu_items`,
`inventory_items`, and every table/service/route/UI surface built on them stay exactly as they are,
indefinitely — not deferred, not a future migration to revisit.** The generic `items`/
`item_variant_attributes`/`item_serials` primitive remains a parallel model, used only by the new
industries; each of those gets its own costing/stock machinery in its own wave (Wave 2's weighted
gold inventory, Wave 5's serialized watches), designed fresh for what that industry actually needs,
rather than either retrofitting F&B's engine onto them or theirs onto F&B's. A full map of every
place `menu_items`/`inventory_items` are touched (migrations, `src/lib/*.ts`, API routes, dashboard
UI, the sale→recipe→costing chain, `sku` usage, AI tools/reporting/exports) was produced while making
this call and confirms the two models can stay fully independent with no coupling left dangling.

## Waves

Same seven waves as the issue, resequenced so the genuinely shared primitive (item/variant/serial)
is built once in Wave 1 instead of separately in Waves 2, 5, and 6:

1. **Wave 1 — Multi-industry core.** `businesses.industry` (immutable after setup, like the
   costing-method lock); domain-event log (`domain_events`: `business_id`, `event_type`, `payload
   jsonb`, `source_type`/`source_id`) + posting-rule engine industry modules register against,
   proven by wiring F&B's own waste posting through it; generic Item/Variant/Serial primitive as a
   parallel model the new industries build on — **not** a migration target for `menu_items`/
   `inventory_items`/`recipes`, which stay exactly as they are (see the revised scope decision
   above); industry-aware setup wizard (Wizard step 1 picks the industry; each industry gets its
   own COA seed template and its own remaining wizard steps — F&B's 8-step wizard is one instance
   of this, not special-cased code).
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

1. ~~**Generic item schema shape**~~ **Settled:** satellite tables per capability (`item_variant_attributes`,
   `item_serials`), matching how `menu_item_ingredients`/`modifier_ingredients` extend `menu_items`
   today — not a wide table with nullable industry-specific columns. Shipped in migration 0050.
2. ~~**Weight precision & rounding**~~ **Settled:** `numeric(24, 9)`, the same precision
   `inventory_lots.remaining_qty` already uses — no new convention. Rounding a computed price into
   integer-Rial reuses the existing `roundRial()`. Shipped in migration 0051.
3. **External gold-price feed** — provider TBD. The hook exists (`gold_prices.source`, shipped in
   migration 0052 and `gold-prices-service.ts`'s `source: 'external'`) and manual entry ships as the
   baseline; a specific integration is still a follow-up once a provider is chosen.
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
  actually decided rather than guessed at here. Not linked from `menu_items`/`inventory_items`/
  `recipes`, and per the revised scope decision above, never will be — this primitive is a parallel
  model for the new industries, not a migration target for F&B's own hardened costing engine.
  Verified in `integration/generic-items.integration.test.ts` (simple
  item creation, variant parent/child creation with attributes — including the all-or-nothing
  failure case leaving no orphan row — and serial registration/status lifecycle, including that a
  `sold` unit can never move to another status and a duplicate serial number is rejected) and
  `src/lib/items.test.ts` (the pure validation rules these lean on).
- All four new tables (`domain_events`, `items`, `item_variant_attributes`, `item_serials`) are
  automatically covered by `integration/tenant-isolation.integration.test.ts`'s generated
  policy-correctness check and `tenant-tables.ts`'s export/restore enumeration — both discover
  tables from `pg_class` rather than a hand-maintained list, so nothing needed updating there;
  re-ran both suites to confirm.

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

Wave 1, third slice — the item-model scope decision — implemented:

- **`menu_items`/`inventory_items`/recipes will not be migrated onto the generic item model, ever
  — a deliberate decision, not a deferral.** See "Revised: `menu_items`/`inventory_items` are not
  migrated" above for the full reasoning (surfaced by a codebase-wide survey of exactly how deep
  F&B's costing engine is wired into `inventory_items`'s own columns). This closes out what was
  previously listed as "remaining Wave 1 work" on that front.

Remaining Wave 1 work: the industry-specific setup-wizard branches (chart-of-accounts template +
remaining steps) for `jewelry`/`watch`/`accessories`, deferred until each of those waves actually
needs them — there is nothing productive to build here before Wave 2+ defines what a gold/watch/
accessories business's own onboarding actually looks like. With the item-model question now settled,
Wave 1's core is otherwise complete.

Wave 2, first slice — weight/purity attributes and daily gold price entry — implemented:

- **Weight precision (open question 2) is settled: no new numeric convention.**
  `item_weight_attributes` (`migrations/0051_item_weight_attributes.sql`) uses `numeric(24, 9)`,
  the same precision `inventory_lots.remaining_qty` already uses (migrations 0012/0015) — deliberately
  generous headroom for a value that in practice never needs more than 3 decimal places, not a new
  decision to get wrong. Money produced by multiplying a weight by a price/gram (Wave 3's pricing
  engine) will round through the existing `roundRial()` (`src/lib/inventory-exact.ts`), the same
  rounding rule every other exact posting already uses.
- **`item_weight_attributes`** (one row per `tracking: 'weight'` item) carries `purity`,
  `gross_weight`, and `net_weight` (`net_weight` defaults to `gross_weight`; Wave 4's stone/gem
  attributes will deduct from it without a schema change). `src/lib/gold.ts` is the pure validation
  (mirroring the table's own CHECK constraints — positive weights, `net_weight <= gross_weight`,
  and a controlled `PURITIES` list: `18`/`21`/`24`). Coin ("سکه") purities are deliberately excluded
  — a coin prices per unit, not per gram, which doesn't fit this table or `gold_prices` below; that's
  a distinct pricing shape for a later wave, not guessed at here. `setWeightAttributes`/
  `getWeightAttributes` (`src/lib/items-service.ts`) validate the item is actually `tracking:
  'weight'` before writing, same pattern `addSerial` already uses for `tracking: 'serial'`.
- **`gold_prices`** (`migrations/0052_gold_prices.sql`) — one row per (business, purity, day),
  upserted rather than logged, since "today's price" is a single current fact. Business-wide, not
  per-location (a business follows one market price across branches, the same reasoning Phase 7 used
  for one consolidated ledger). `source` defaults to `'manual'` (the decided baseline) with an
  `'external'` value already modeled for the optional price-feed hook the brainstorm called for — no
  provider is wired up in this slice. `getGoldPrice`/`listCurrentGoldPrices`
  (`src/lib/gold-prices-service.ts`) read the latest price on or before a given date, so a business
  isn't forced to re-enter a price every single day.
- Both new tables are automatically covered by `integration/tenant-isolation.integration.test.ts`'s
  generated policy-correctness check (re-ran to confirm, 19 tests, no change needed).
- Verified in `src/lib/gold.test.ts` (the pure validation rules), extended
  `integration/generic-items.integration.test.ts` (setting/reading weight attributes, rejecting a
  non-weight-tracked item, upsert-replaces-not-duplicates, and the CHECK constraint itself rejecting
  `net_weight > gross_weight` even bypassing the service layer), and new
  `integration/gold-prices.integration.test.ts` (record/read, same-day replace not duplicate,
  independent purities, falling back to the most recent earlier price, per-business isolation, and
  the manual/external `source` distinction). `npx tsc --noEmit`, `npm test` (911 tests), `npm run
  test:db` (287 tests), and `npm run build` all pass.

Not yet built (later Wave 2 slices, or Wave 3): weight-based lots/FIFO consumption for bulk gold
stock, weight-based stock counts, and the setup-wizard's jewelry chart-of-accounts *branch* (the
template itself now exists — see Wave 3 below — but no wizard step offers `jewelry` as a selectable
industry yet, so nothing seeds it for a real business).

Wave 3, first slice — the gold pricing engine and a real (though not yet UI-wired) sale flow —
implemented. Two product decisions were confirmed with the product owner before writing any code,
since both carry real correctness/compliance stakes rather than being implementation details:

1. **VAT applies only to اجرت (making charge) + سود (profit), never the metal value.** Metal value
   is VAT-exempt under Iranian tax practice for gold jewelry — this is not a simplification, it's the
   actual rule, so `computeGoldSalePrice` (`src/lib/gold-pricing.ts`) computes VAT off
   `makingCharge + profit` only, and the two revenue accounts below exist specifically so the
   VAT-exempt and VAT-applicable portions of a sale are reportable separately, not commingled in one
   "gold sales" line.
2. **A gold piece's cost basis is a simple average cost per piece, recorded at intake
   (`unit_cost_per_gram`), not FIFO lots.** Bulk-gold FIFO tracking across many fungible pieces stays
   deferred (same open item as Wave 2's "not yet built" list above) until a business actually needs
   to pool raw material across pieces — this wave needed *a* real cost basis to post COGS, not the
   most general one.

What shipped:

- **Jewelry chart of accounts** (`src/lib/coa-template.ts`) — `JEWELRY_COA_TEMPLATE`, mirroring
  `FNB_COA_TEMPLATE`'s structure, reusing every generic account (cash, bank, AR, AP, VAT
  receivable/payable) and adding four new well-known codes: `goldInventory` (1320),
  `goldSalesRevenue` (4500, VAT-exempt metal value), `makingChargeRevenue` (4600, making charge +
  profit combined — VAT-applicable), `goldCogs` (5110). `WELL_KNOWN_CODES` is now a shared,
  multi-industry catalog rather than an implicitly-F&B-only one; `coa-template.test.ts` was updated
  to check each template against only the well-known codes its own industry actually uses, rather
  than asserting every template contains every code. Not yet seeded by any wizard branch — exists so
  the posting rules and their tests have real accounts to post against ahead of that UI work.
- **`item_weight_attributes` gained `unit_cost_per_gram` (nullable) and `status`**
  (`migrations/0053_item_weight_cost_status.sql`) — `status` (`in_stock`/`reserved`/`sold`) mirrors
  `item_serials.status` exactly, including `sold` being terminal
  (`validateWeightItemStatusTransition`, `src/lib/items.ts`); `setWeightItemStatus`
  (`items-service.ts`) mirrors `setSerialStatus`.
- **`src/lib/gold-pricing.ts`** — `computeGoldSalePrice`: metal value (net weight × price/gram,
  rounded), making charge (percent of metal value, or a flat amount), profit (percent of metal value
  + making charge), VAT (percent of making charge + profit only, per decision 1 above). Every
  component is rounded to whole Rial *as it's computed*, each stage built on the *previous stage's
  rounded value* — not one independent rounding of a final total — so a receipt's line items always
  sum to exactly the displayed total.
- **`src/lib/gold-posting-rules.ts`** registers two rules against Wave 1's engine — `gold.sale_revenue`
  (Debit Cash/Bank-Clearing/Accounts-Receivable by payment method; Credit `goldSalesRevenue` for
  metal value, `makingChargeRevenue` for making charge + profit, `vatPayable` for VAT) and
  `gold.sale_cogs` (Debit `goldCogs` / Credit `goldInventory` for net weight × `unit_cost_per_gram`)
  — mirroring Phase 7's "two entries per sale, not one" decision for F&B order payments (revenue
  recognition and cost of goods sold are conceptually distinct events).
- **`src/lib/gold-sales-service.ts`**'s `sellWeightedItem` orchestrates a full sale in the caller's
  transaction: validates the item is `tracking: 'weight'` and `status: 'in_stock'` with a cost basis
  set, looks up the day's price for its purity (Wave 2's `gold_prices`), computes the breakdown, posts
  both domain events, and flips the item to `sold` — all atomic, same discipline as every existing
  ledger posting path.
- Verified in `src/lib/gold-pricing.test.ts` (the formula itself: standard case hand-computed and
  checked line by line, VAT excluding metal value even when making charge/profit are zero, fixed vs.
  percent making charge, rounding, and every validation rejection) and
  `integration/gold-sales.integration.test.ts` (a full sale posting a balanced revenue entry and a
  balanced COGS entry with the exact expected amounts, the item flipping to `sold`, refusing to sell
  the same piece twice, refusing a sale with no cost basis set, and refusing a sale with no price
  entered for the item's purity). `npx tsc --noEmit`, `npm test` (926 tests), `npm run db:migrate`
  (twice) + `npm run test:db` (291 tests, `tenant-isolation`'s 19 tests re-confirming RLS), and
  `npm run build` all pass.

Not yet built (Wave 3 continued): no API route or POS/receipt UI calls `sellWeightedItem` yet
(service-layer only, same as how Wave 1 and Wave 2 each started); weight-based lots/stock-counts
remain deferred; and jewelry still isn't a selectable industry in `/welcome` (`ENABLED_INDUSTRIES`),
so none of this is reachable by an actual business yet — proven by integration test, not by a live
business, exactly like Wave 2's first slice.

Wave 4, first slice — gem/stone attributes as a cost add-on — implemented (consignment, Wave 4's
other half, deliberately not started this slice — its sale/commission mechanics need the same kind
of domain-specific confirmation VAT and cost-basis needed in Wave 3, not yet asked):

- **`item_stones`** (`migrations/0054_item_stones.sql`) — a child table (an item can carry several
  stones, e.g. a ring with a center diamond plus accent stones): `stone_type` (free text, unlike
  purity's controlled list — gem types vary far more than gold's fixed karat scale), `carat`, `cost`.
  Deliberately does **not** touch `item_weight_attributes.net_weight` — a stone's carat weight is not
  auto-converted to grams and subtracted from `gross_weight`; that conversion (irregular settings,
  mounting metal) would be a fragile approximation nobody asked for, so `net_weight` stays exactly
  what it's been since Wave 2: the business's own directly-entered gold-content figure. A stone's
  `cost` is what actually needs to flow into COGS.
- **`gold-posting-rules.ts`'s `gold.sale_cogs` rule now sums `item_stones.cost` alongside the metal
  cost** — read live from `item_stones` at posting time via the same client/transaction, not passed
  through the domain event's payload, the same "resolve against the current record, not a
  caller-supplied snapshot" instinct `accountIdsByCode` already uses for account ids.
- `src/lib/gold.ts` gained `validateStone`; `items-service.ts` gained `addStone`/`listStones`/
  `removeStone`/`totalStoneCost`, validating the item is `tracking: 'weight'` before allowing a
  stone, mirroring every other satellite-attribute function's own item-type guard.
- Verified in `src/lib/gold.test.ts` (stone validation) and extended
  `integration/generic-items.integration.test.ts` (add/list/remove, summing costs with zero-stones
  as the empty case, refusing a stone on a non-weight-tracked item, and confirming `net_weight` stays
  untouched) and `integration/gold-sales.integration.test.ts` (a real sale with a stone posts COGS as
  metal cost + stone cost, hand-verified). `npx tsc --noEmit`, `npm test` (930 tests), `npm run
  db:migrate` (twice) + `npm run test:db` (297 tests, `tenant-isolation`'s 19 tests re-confirming
  RLS), and `npm run build` all pass.

Wave 4, second slice — consignment (امانی) — implemented. Confirmed with the product owner before
writing any code: **a consigned piece is priced with the exact same formula as the shop's own
inventory** (`computeGoldSalePrice`, unchanged) — سود (profit) simply *means* the shop's commission
here instead of margin on owned stock, rather than consignment needing a different, negotiated-price
pricing model.

- **`consignors`** (`migrations/0055_consignment.sql`) mirrors `customers` (migration 0001) exactly
  — same shape, same Shape 1 RLS — and `src/lib/consignment-service.ts` mirrors
  `customers-service.ts`'s simplicity: no separate pure-validation module, matching how
  customers/suppliers are already validated inline in this codebase (that split is reserved for real
  computational logic like costing/pricing math, not "name is required").
- **`item_consignments`** (1:1 with an item, like `item_weight_attributes`) marks a `tracking:
  'weight'` item as held for a consignor rather than owned. No pre-agreed commission column — the
  sale-time making-charge/profit/VAT inputs (already how an owned sale works since Wave 3) are reused
  as-is; the commission rate is decided at the point of sale, not fixed at intake.
- **`gold-sales-service.ts`'s `sellWeightedItem` now branches on consignment status**: a consigned
  item skips the cost-basis requirement entirely (there's no "what the shop paid" for something it
  never bought) and posts through a new `gold.consignment_sale_revenue` rule instead of
  `gold.sale_revenue`/`gold.sale_cogs` — Debit the payment account for the total, same as an owned
  sale; Credit the new `consignmentPayable` liability for metal value + making charge (owed to the
  consignor, not the shop's revenue); Credit the new `consignmentCommissionRevenue` for profit (the
  shop's actual earning on the sale); Credit `vatPayable`, unchanged. **No COGS entry is posted at
  all for a consignment sale** — the shop never owned the piece, so there's nothing to relieve from
  an inventory asset it never held.
- Deliberately deferred (its own follow-up slice, mirroring how Phase 16 built AR/AP's invoice-then-
  collect/pay lifecycle in two stages): actually paying out the consignor their `consignmentPayable`
  balance. This slice creates the payable; settling it is separate, the same "invoice, then
  collect/pay" shape Phase 16's AR/AP subledgers already use.
- Verified in `integration/consignment.integration.test.ts` (consignor CRUD, marking an item
  consigned and refusing it on a non-weight-tracked item, a full consigned sale posting the correct
  three-way split with hand-verified amounts and *zero* `gold.sale_cogs` event, confirming the
  owned-inventory accounts are never touched by a consignment sale, and confirming an *unconsigned*
  item still requires its cost basis exactly as Wave 3 left it — a regression check, not just a new
  feature check). `npx tsc --noEmit`, `npm test` (930 tests — no new pure-unit coverage needed, per
  the customers/suppliers-style validation above), `npm run db:migrate` (twice) + `npm run test:db`
  (303 tests, `tenant-isolation`'s 19 tests re-confirming RLS on the two new tables), and `npm run
  build` all pass.

Not yet built: paying out a consignor's `consignmentPayable` balance (see above); consignment
statements/balances by consignor (Phase 16's AR/AP built these as their own slice too, off the same
"reconstruct from journal lines, never a shadow copy" discipline); and, as with every wave so far, no
API route or UI — service-layer only, proven by integration test.
