# Phase 25 — Industry Separation: the business type as a real product boundary

Tracked by GitHub issue [#233](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/233),
with one sub-issue per wave: [#234](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/234),
[#235](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/235),
[#236](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/236),
[#237](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/237).

## Numbering note

24 was taken by the security-hardening phase (issue #228, designed but not started), so this is
**Phase 25**. It does not depend on Phase 24 and can ship before it.

## Context: what existed after Phase 21

[Phase 21](Phase-21-Multi-Industry-Accounting-Platform.md) built the multi-industry **backend** and
built it well: `businesses.industry`, a chart of accounts per industry, the domain-event posting
engine, the `items`/`item_serials`/`item_weight_attributes`/`item_stock` model, and a dashboard page
for each of jewelry, watch and accessories. None of that is changed here.

What was never built is the **product boundary in front of it**. Four concrete gaps:

1. **No super-admin could pick a business type.** `grep -rn "industry" src/app/platform` returned
   nothing. The console's provision form collected name/subdomain/owner/password and no industry,
   so every business a super-admin created silently became `food_service` *with the F&B chart of
   accounts* — even though `validateProvisionBody` had accepted and validated the field since
   Phase 21. No caller ever sent it. The console could not even display a tenant's type. The only
   industry picker in the product was `/welcome`, the first-run bootstrap page, which a
   console-provisioned business never sees.
2. **Industry only ever added; it never removed or renamed.** `NAV_ITEMS` gated the three industry
   pages with `industry: "jewelry" | "watch" | "accessories"`, but every F&B entry — سفارش‌ها،
   صندوق (فروش)، میزها، میزهای من، آشپزخانه، رزروها، ارسال و پیک، انبار — was gated only on
   *feature flags*, and nothing set `industry: "food_service"` on any of them. A jewellery shop got
   the whole café app with a «طلا و جواهر» tab bolted on, a sidebar whose brand block read
   «کافه و رستوران», a home page showing «سفارش‌های فعال» with a «میز / نوع» column that would
   always be empty, and settings tabs called «منو و ورود فایل» and «مالیات — نرخ هر دسته از منو».
3. **The retail industries had no sale document.** `sellWeightedItem`, `sellSerializedUnit` and
   `sellAccessoryUnits` each sold exactly one item straight from an admin panel into the ledger.
   No order row, no customer, no line items, no invoice number, nothing printable, and nothing in
   any sales history. The shop's main daily act — writing an invoice for a customer buying two
   rings and a chain — had no screen at all, while `/dashboard/pos` offered a grid of `menu_items`
   the shop does not have.
4. **There was no terminology layer.** No i18n module; ~5,000 lines of Persian literals across 329
   files. The only industry-keyed strings anywhere were `INDUSTRY_LABELS` — four display names.

**Intended outcome:** the business type becomes the single switch that decides which modules exist,
what they are called, and how a sale is written down — chosen by a super-admin, visible and
changeable, driving one profile that every nav entry, settings tab, page guard and label reads
from. No industry re-implements anything the core already does.

## Decisions

| Question | Decision |
|---|---|
| Super-admin control of industry | Picks it at create **and can change it at any time**, regardless of existing data |
| Retail sale document | Reuse `orders`/`order_items` — a retail invoice *is* an order |
| Where retail sells from | Same `/dashboard/pos` route, branching on the profile's `salesModel` |
| `/dashboard/orders` for retail | **No.** It is a board of *open* tickets; a settled invoice would never appear there. The shop's history lives on its selling screen |
| Scope of the label layer | Only the nouns that genuinely differ by trade. This is **not** an i18n layer and must not become one |

### The changeable-industry risk, and how it is handled

Migration `0048_business_industry.sql` made `industry` immutable *by omission* — no update route
existed — precisely because the chart of accounts is seeded from it at creation. The product owner
asked for it to be changeable at any time, so it is; the risk is contained rather than blocked:

- Seeding is **additive**. `seedChartOfAccounts` is now idempotent by code: it skips every account
  code the business already has, so existing accounts, their names, and every journal entry posted
  against them survive untouched. It returns the codes it actually inserted.
- Data belonging to the old model (`menu_items` for an ex-café, `items` for an ex-jeweller) is left
  in place. It stops being reachable from the new industry's UI; nothing is deleted.
- `industryDataCounts` gives the console the real numbers *before* the admin confirms, so the
  warning is a fact rather than a generic scare.
- The change lands in `platform_audit_log` as `business.industry_change` with
  `{ from, to, seededAccountCodes }`. `from` is the point of the record: once the column is
  overwritten, nothing else remembers what the tenant used to be.

Reconciling pre-existing data of the old trade is explicitly the operator's call, not something
this phase attempts.

---

## Scope — Wave 1: super-admin owns the business type

- `src/app/platform/industry-picker.tsx` *(new)* — the console's picker, shared by the provision
  form and the industry panel. It deliberately does **not** share a component with the identical
  grid on `/welcome`: that one renders in the tenant app's light theme, the console has its own
  dark palette, and sharing would thread two design systems through one component. What *is* shared
  is `INDUSTRIES`/`ENABLED_INDUSTRIES`/`INDUSTRY_LABELS`, so neither copy can drift.
- `src/app/platform/page.tsx` — required picker on the provision form; industry column in the
  business table and on the mobile card.
- `src/app/platform/businesses/[id]/page.tsx` — industry in the detail `<Meta>` rows, plus
  `IndustryPanel` to change it, gated on the existing `business.edit` capability.
- `src/lib/platform-service.ts` — `industry` on `BusinessSummary`; `changeBusinessIndustry`;
  `industryDataCounts`.
- `src/lib/business-provisioning.ts` — `seedChartOfAccounts` exported and made idempotent.
- API — `POST /api/platform/businesses` passes and audits `industry`; `PATCH .../[id]` accepts it
  as its own action (like a subdomain rename, not a metadata field) and audits
  `business.industry_change`.
- `src/lib/pairing-apply.ts` / `pairing-service.ts` / `pairing-snapshot.ts` — `industry` crosses in
  the pairing snapshot. It was missing, so a paired jewellery business came up as a café on the
  laptop. Optional with a `food_service` fallback, the same back-compat shape as `subdomain`.

## Scope — Wave 2: one profile drives the shell

- `src/lib/industry-profile.ts` *(new)* — the one place that answers "what does this industry get,
  and what is it called": `modules`, `labels`, `salesModel`, `brandTitle`/`brandSubtitle`,
  `defaultDisabledFeatures`. Framework-free like `industries.ts` and `wizard-steps.ts` — whose
  `FOOD_SERVICE_ONLY_STEPS` this generalises — so client and Edge code can import it.
- `src/lib/industry-guard.ts` — `isModuleEnabled` / `requireModuleForPage` beside the existing
  per-industry helpers.
- `src/lib/auth.ts` — `moduleForApiPath` checked in `withTenantScope` at exactly the point
  `featureForApiPath` already was. **This is what makes the module set real**: hiding a nav entry
  is decoration if the route still answers, so a jewellery business asking `/api/tables` gets a
  403 `module_unavailable`.
- `src/app/dashboard/layout.tsx` — nav entries name a `module` instead of carrying an `industry`
  field, and take their label from `labelFor`.
- `src/lib/settings-tabs.ts` — tabs gained `module` and `industryText`; `visibleSettingsTabs` takes
  the industry. «منو و ورود فایل» and «پلتفرم‌های سفارش آنلاین» disappear for retail;
  «مالیات» and «قیمت‌گذاری» stop describing themselves in menu terms.
- `src/lib/business-provisioning.ts` — `disableFeatures` extracted (the loop
  `LOCAL_DISABLED_FEATURES` already used) and applied to each industry's defaults at provision.
  `changeBusinessIndustry` applies them in **both** directions: the outgoing industry's overrides
  are cleared where the incoming one has no opinion, or a business switched to `food_service` would
  come up with no tables and no floor plan.

## Scope — Wave 3: the retail invoice

- `migrations/0071_retail_invoices.sql` — `retail` added to `order_type`; `order_items.item_id`
  (the generic-item counterpart of the existing nullable `menu_item_id`); `metal_value`,
  `making_charge`, `profit` for the gold breakdown. No new table, so no new RLS policy: both tables
  are already tenant-scoped through `location_id`.
- `src/lib/retail-invoice-service.ts` *(new)* — writes the document and then calls the **existing**
  `sellWeightedItem` / `sellSerializedUnit` / `sellAccessoryUnits`, one per line, in the same
  transaction. Every ledger posting, stock decrement, serial status change and consignment
  settlement is what Phase 21 already does. The order is opened, filled, then completed, because
  `guard_order_item_mutation` (migration 0014) refuses lines on an order that is not open — the
  invariant that makes a settled sale immutable, respected rather than weakened.
- `src/app/api/sales/invoices/route.ts` *(new)* — `POST` writes one; `GET` lists this branch's.
  Gated on the profile's `salesModel`, not a named industry, so a fifth trade is a profile entry.
- `src/app/dashboard/pos/page.tsx` — branches on `salesModel`; F&B's screen is untouched.
- `src/app/dashboard/pos/retail-invoice-screen.tsx` *(new)* — a cart over the industry's own
  catalogue, pricing each line through that trade's pure pricing module and showing the breakdown
  before the sale is posted, so a jeweller and a customer agree the اجرت first.
- `src/lib/receipt-template.ts` — optional gold breakdown and customer name on the existing pure
  template rather than a second one. An invoice showing only a total is not a document the
  jewellery trade accepts.
- The GET handlers of `/api/jewelry/items`, `/api/watch/units`, `/api/accessories/items` and
  `/api/jewelry/prices` now admit `cashier`, exactly as `/api/menu`'s GET already did. Their write
  handlers stay owner/manager.

## Scope — Wave 4: industry home, shared shell, docs

- `src/app/api/dashboard/retail-overview/route.ts` + `src/app/dashboard/retail-overview.tsx`
  *(new)* — the retail counterpart of the F&B overview: today's takings and invoice count, what is
  sellable, and the one number that changes daily for the trade (the gold rate, open repair
  tickets). For a jeweller with no rate recorded, this is where that shows — without it,
  `sellWeightedItem` refuses every sale.
- `src/app/dashboard/industry-manager-shell.tsx` *(new)* — the error box, tab strip and labelled
  region the three industry managers had three identical copies of, plus the shared `Runner` type.
- The per-item «فروش» panels in `items-section.tsx`, `units-section.tsx` and
  `variants-section.tsx` become links to the invoice screen, so there is one way to sell rather
  than two that post identically. The `/sell` API routes stay: they are part of the industry API
  surface, and only the duplicated UI is removed.

## Out of scope

- `menu_items` / `inventory_items` / recipes are **never** migrated onto the generic `items` model
  — Phase 21's recorded "Revised" scope decision stands.
- The posting rules (`*-posting-rules.ts`, `posting-engine.ts`) are not changed.
- RLS and the Phase 23 subdomain/origin boundary are not touched.
- No general i18n framework.
- `/dashboard/orders` is not adapted for retail, by decision — see the table above.

## Where each exit criterion is satisfied

| Exit criterion | Where |
|---|---|
| A super-admin can create a business of any industry from the console | `src/app/platform/page.tsx` `ProvisionForm`, `src/app/platform/industry-picker.tsx` |
| …see its type in the list and on the detail page | `platform/page.tsx` table + card, `platform/businesses/[id]/page.tsx` `<Meta>` |
| …and change it, audited | `IndustryPanel`, `PATCH /api/platform/businesses/[id]`, `changeBusinessIndustry`, audit action `business.industry_change` |
| A retail business sees no میزها / آشپزخانه / رزروها / منو — nav, settings **and** API | `industry-profile.ts` module sets, `dashboard/layout.tsx` `canSee`, `settings-tabs.ts`, `moduleForApiPath` in `auth.ts`'s `withTenantScope` |
| Nothing in a retail business's shell uses café wording | `labelFor`, `brandTitle`/`brandSubtitle` via `dashboard-sidebar.tsx`, `retail-overview.tsx` |
| A retail business can write, settle, print and later find a multi-line invoice | `retail-invoice-service.ts`, `/api/sales/invoices`, `retail-invoice-screen.tsx` + its recent-invoices panel, `receipt-template.ts` |
| …with ledger entries identical to the single-item path | `integration/retail-invoice.integration.test.ts`, asserted against `integration/gold-sales.integration.test.ts`'s arithmetic |
| An F&B business is unchanged | `industry-profile.test.ts` ("gives food_service everything the app has today"), plus the whole pre-existing suite passing |

## Verification

Per `CLAUDE.md`, from the repo root — these mirror the CI `test` job:

```bash
docker compose up -d && npm run db:migrate
npx tsc --noEmit
npm test          # incl. industry-profile.test.ts
npm run test:db   # incl. business-industry + retail-invoice integration tests
npm run build
```

Manually:

- **W1** — provision a business as «طلا و جواهر» from the console; confirm the jewelry chart of
  accounts (1320/4500/4600/5110), not the F&B one. Change an empty business's type and confirm the
  new accounts appear, nothing is deleted, and `business.industry_change` lands in
  `/platform/audit`.
- **W2** — log into that business: no میزها/آشپزخانه/رزروها/منو in the sidebar, no
  «کافه و رستوران», and both `/dashboard/floor` and `/api/tables` refuse rather than render empty.
  Log into an F&B business and confirm its nav, settings tabs and POS are what they were.
- **W3** — write an invoice with two pieces and a customer, settle it, confirm it appears under
  فاکتورهای اخیر and that the printed document shows the وزن/عیار/اجرت breakdown. Repeat for a
  watch serial and an accessories variant.
- **W4** — confirm the retail home shows real numbers and no empty «سفارش‌های فعال» table, and
  that a jeweller with no gold rate recorded is told so on the home page.

## Fixes after the phase shipped

1. **`/dashboard/settings` returned a 500 for every business, on every industry, from Wave 2 until
   this fix.** Reported as "the app settings has a problem", with Next.js's generic
   `Application error: a server-side exception has occurred while loading {host}` page and a digest.
   The server log names the real error: *"Functions cannot be passed directly to Client Components
   unless you explicitly expose it by marking it with `use server`"*, pointing at the `tax` and
   `pricing` tabs' `industryText`.

   Wave 2 gave a `SettingsTab` a function field (`industryText`) so a tab could reword itself per
   trade. `visibleSettingsTabs` calls it — and then returned the tab with the function still
   attached, by both of its paths: the tab whose rewrite returns `{}` (F&B's `tax`) was passed
   through untouched, and the tab whose rewrite returns a description (`pricing`, always) was
   `{...tab, description}`-spread, which copies `industryText` along with everything else.
   `src/app/dashboard/settings/page.tsx` is a server component that hands the result straight to
   `<SettingsManager>`, a client one, so React tried to serialize a function across the RSC boundary
   and threw at render time. Nothing catches that earlier: `tsc --noEmit` and `next build` both pass,
   because a function *is* a legal property of the declared type — the boundary is only checked when
   the page actually renders. `src/app/dashboard/layout.tsx` calls the same function but only reads
   `.length`, which is why the sidebar's settings entry appeared and only the page behind it broke.

   Fixed in the resolver rather than at the call site: `visibleSettingsTabs` now destructures
   `industryText` off unconditionally and returns `ResolvedSettingsTab` (`Omit<SettingsTab,
   "industryText">`), so the field cannot reach a client component from anywhere. The wording feature
   itself is unchanged and now actually visible — «هدف حاشیه سود پیش‌فرض برای پیشنهاد قیمت کالاها» on
   the retail trades vs. «…آیتم منوها» on `food_service`. Pinned by two tests in
   `src/lib/settings-tabs.test.ts` (one asserting every resolved tab is JSON-round-trippable and
   carries no function-valued property, across all four industries; one asserting the per-industry
   wording still applies through both paths), which fail on the unfixed resolver. Verified live
   against a real server running as the unprivileged `pos_app` role with `ROOT_DOMAIN` set: the page
   500s before the change and renders for all four industries after it, with no other page route in
   the app returning a 500.

## Known follow-ups

- A dedicated فاکتورها history *page* (with filters and a detail view) would be better than the
  recent-invoices panel once shops have volume; the panel is what Wave 3 shipped.
- `resetBusiness` (`platform-service.ts`) re-inserts a business without its `subdomain`, so a
  factory reset silently moves the tenant to a fresh `biz-*` host. Pre-existing, unrelated to this
  phase, and worth its own fix.
- `CLAUDE.md` names the CI workflow `.github/workflows/deploy.yml`; it is actually
  `.github/workflows/test.yml`.
