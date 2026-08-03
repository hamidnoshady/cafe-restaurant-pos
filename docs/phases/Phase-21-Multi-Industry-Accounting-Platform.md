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

Wave 1, second slice — the posting engine's first real (non-test) wiring, and the item-model scope
call — implemented (in a separate PR from the first slice):

- **The engine was switched to exact (RialText/BigInt) arithmetic**, not plain-number `Rial`.
  Auditing F&B's actual live posting surface (as opposed to the architecture principle's original
  description) found that every inventory-costing-sensitive posting path — order payment, COGS,
  purchases, waste, stock counts, customer refunds — already uses a private
  `postExactJournalEntry`/`RialText`/`Decimal`-based path in `ledger-service.ts`, distinct from the
  plain-`number` `postJournalEntry` the engine originally used (that one is still correct for
  manual journals/AR-AP/payroll/expenses/closing, which never multiply a fractional quantity by a
  unit cost). The engine as first shipped would have been the wrong foundation for Wave 2's
  weight × price/gram gold-pricing math — fixed by exporting `postExactJournalEntry`/
  `ExactJournalLine` and switching `dispatchDomainEvent` onto them, plus adding
  `postingKind`/`inventoryEventId` passthrough (the two fields every existing exact posting path
  already stamps). `PostingRule` also now receives the transaction's `PoolClient` (a real gap in
  the original signature — a rule needs to call `accountIdsByCode`).
- **`src/lib/fnb-posting-rules.ts`** registers `inventory.operational_posting`, mirroring
  `postExactOperationalInventoryEntry`'s own parametrised shape; the waste route (its only real
  caller) now emits through the engine instead of calling it directly. That function itself is
  unchanged and still directly covered by its own integration test. The rest of F&B's posting
  functions are deliberately **not** migrated — proven and load-bearing, no product need to move
  them until a new industry actually needs to share their logic. Verified in extended
  `integration/posting-engine.integration.test.ts` and new
  `integration/fnb-posting-rules.integration.test.ts` (proves the registered rule and calling
  `postExactOperationalInventoryEntry` directly agree on identical inputs), plus a manual
  end-to-end pass against a running server (waste entry → `domain_events` row stamped with
  `entry_id` → correct journal entry).
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
