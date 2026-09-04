# Phase 38 — Website manager (مدیریت وب‌سایت)

> **Numbering note.** "Phase 38" was also used in this index for the WooCommerce
> catalogue phase; this document covers the *website manager* issues #378–#382
> and is filed as **38w** in the index, the same way 23b/18b/37b keep collisions
> apart.

Status: **Waves 1, 3 and 4 implemented.** Wave 2 (a content adapter written from
scratch) was deliberately not built: by the time this phase was picked up the
website app (`/dashboard/website`, `src/lib/cms/*`, migration `0122`) already
held the one credential and the one HTTP client that talks to
[`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms). Wave 1 therefore
*wraps* that client as the first `WebsiteAdapter` rather than replacing it, and
the issue's proposed `website_connections` table became a forward-only extension
of `eshobe_cms_connections` — one connection, one credential store.

The sentence the phase is built around, now also a CLAUDE.md rule:

> **سایت ویترین است؛ منبع حقیقت اینجاست.** The site is a shop window; the
> source of truth for price and stock is this app. Sync is one-way, from here to
> there, and the site never writes back a price or a quantity.

## Scope

- **Wave 1 (#379)** — a `WebsiteAdapter` interface (`src/lib/website/adapter.ts`),
  an in-memory mock provider for tests, and the Payload provider over the
  existing CMS client. A `website` connection kind in the Connections hub,
  owner-only, gated on `integrations`; test-before-save; the key never returned.
- **Wave 3 (#381)** — one-way product/stock/price push: `website_product_map`,
  `website_outbox`, `runWebsiteSyncTick()` in `server.ts`, per-product opt-in,
  independent price/stock switches, a queue page with retry.
- **Wave 4 (#382)** — the assistant: three read tools, four catalogue actions
  (`website.post.draft`, `website.post.update`, `website.product.upsert`,
  `website.post.publish`), an `app:website` prompt snippet. **Publishing always
  requires a human**, whatever autopilot says.
- **Not in scope** — a second content adapter (WordPress etc.), the site pulling
  orders back into this app (that is the CMS's own webhook, unchanged), any
  storefront editing UI beyond what `/dashboard/website` already has.

## The adapter (`src/lib/website/`)

```
adapter.ts               interface + WebsiteAdapterError + Persian labels + slugify   (pure)
providers/mock.ts        in-memory reference implementation, failWith() for tests    (pure)
providers/payload.ts     eshobe-cms over src/lib/cms/client.ts                        (pure w/ fetchImpl)
providers/payload-content.ts   Markdown ⇄ Lexical subset, round-trips               (pure)
connection-service.ts    the row, connect/test/disconnect, adapterForBusiness()      (DB)
sync.ts                  planProductEvents / afterFailure / sellableFromIngredients  (pure)
sync-service.ts          fill + drain + runWebsiteSyncTick                            (DB)
catalog-service.ts       product list with marks, queue views                         (DB)
content-service.ts       the assistant's 4 writes + 3 reads over the adapter         (DB)
```

Contract decisions, each tested:

| Decision | Why | Test |
| --- | --- | --- |
| **Money is integer Rial across the whole interface.** The Payload adapter converts to the site's minor unit from `site_currency` on the row (IRT ×10, IRR exact); EUR/USD sites get `unsupported`. | The app's own rule since Phase 0; a Toman site is a display concern of the site. | `payload.test.ts` |
| **Content crosses as Markdown.** `payload-content.ts` maps a subset (paragraphs, h1–h3, lists, bold/italic/link, `---`) to Lexical and back. | The assistant writes Markdown; no caller should know what a Lexical node is. | `payload-content.test.ts` round-trips |
| **`draftPost` never publishes** — the Payload body is always `_status: "draft"` whatever the input says. | Wave 4's hard line has to hold at the lowest layer, not only in the gate. | `payload.test.ts`, `mock.test.ts` |
| **One error type crosses the boundary**: `unreachable` (retryable) / `unauthorized` / `not_found` / `rejected` / `unsupported`. A CMS 403 whose message mentions publishing maps to `unsupported` — the site key cannot publish. | The outbox needs one bit — retry or not — and the UI needs one Persian sentence. | `payload.test.ts` `mapCmsError` |
| **A process-wide circuit breaker per site** (3 failures → open 60 s). 4xx does not trip it. | A site that is down must cost one failed call per tick, not a timeout per queued row. | `payload.test.ts` breaker |

## Wave 1 — connection

- `website` joins `CONNECTION_KIND_KEYS` (`connection-kinds.ts`): `allowedRoles: ["owner"]`,
  `feature: "integrations"`. The hub stays ungated; the tab renders locked when the flag is off,
  like Holoo. A Manager never sees it (`connection-kinds.test.ts`).
- `src/app/dashboard/connections/website-panel.tsx` — connect form, connected card with
  «آزمایش اتصال» / «قطع اتصال», the sync switches, the product list, the queue.
- `connectWebsite()` runs `adapter.testConnection()` **before** `INSERT … ON CONFLICT`; a failed
  test stores nothing and returns the adapter's code. Re-connecting rotates the key.
- `WebsiteConnectionSummary` has no field for the key; the plaintext exists inside the adapter's
  HTTP client and nowhere else. `GET /api/connections/website` returns the summary + queue counts.
- `adapter_key` on the row picks the provider (`payload` | `mock`); the mock is refused in
  production by the route.

## Wave 3 — one-way sync

Migration `0136_website_manager.sql`:

- `eshobe_cms_connections` + `adapter_key`, `site_currency`, `last_checked_at`, `last_error`,
  `push_prices`, `push_stock`, `product_scope` (`selected` | `all`), `sync_location_id`.
- `website_product_map (business_id, local_kind item|menu_item, local_id, remote_id, sync_enabled,
  last_pushed_at, last_pushed_price_rial, last_pushed_stock)`, UNIQUE on the local product.
- `website_outbox (business_id, kind product.upsert|stock.set|price.set, local_kind, local_id,
  payload, status, attempts, next_attempt_at, error, sent_at)`, **UNIQUE (business_id, kind,
  local_kind, local_id)** — the coalescing rule.
- RLS enabled + forced + `tenant_isolation` on both new tables, in the same migration.

The rules, all in pure `sync.ts`:

1. **Nothing goes unless marked.** `sync_enabled` defaults false; `product_scope = 'selected'` by
   default. `planProductEvents` returns `[]` for an unmarked product whatever changed.
2. **Upsert first.** An unmapped product needs `product.upsert` and nothing else — the follow-ups
   would have no remote id. The drain orders upserts ahead of everything.
3. **Price and stock are two switches**, diffed independently against `last_pushed_*`.
4. **Coalesce, and read at send time.** A hundred sales re-arm one `stock.set` row (the UNIQUE);
   the drain reads the quantity from the database when it sends — the row's payload only names the
   product. Phase 32's rule: the event says *which*, the database says *how much*.
5. **Retry policy is the WooCommerce outbox's** (`integrations/retry.ts`): exponential backoff,
   dead-letter at `OUTBOX_MAX_ATTEMPTS`. A non-retryable error (`unauthorized`, `not_found`,
   `rejected`) dead-letters at once. `unreachable` stops the batch and lets the backoff work.
6. **Both product models.** `menu_items` (F&B, price on the row, sellable = min over recipe
   ingredients) and `items` + `item_stock` (retail, `unit_price` and `quantity`). They never merge.

`runWebsiteSyncTick()` mirrors `runWooCommerceSyncTick`: enumerate active connections under the
existing `"platform"` bypass reason, `withTenant` per business, fill then drain, swallow each
business's own error. No new `withoutTenantScope` reason. A site that is down simply grows its
queue; nothing is lost.

Owner surfaces: `PATCH /api/connections/website/settings` (switches), `GET|POST
/api/connections/website/products` (list + mark), `GET /api/connections/website/queue`,
`POST …/queue/[id]/retry`, `POST /api/connections/website/sync` («همگام‌سازی اکنون»).

## Wave 4 — the assistant

**Reads** (in `toolDefinitions("dashboard")`, hence automatically in the MCP catalogue with
English summaries in `MCP_READ_TOOL_SUMMARIES`): `list_website_posts`, `list_website_products`,
`get_website_status`. A missing connection is an answer, not an exception.

**Writes** in `ACTION_CATALOG`:

| Action | Category | Executor | MCP tool | Endpoint |
| --- | --- | --- | --- | --- |
| `website.post.draft` | `website` | `websitePostDraft` | `write_website_post_draft` | `POST /api/cms/website/drafts` |
| `website.post.update` | `website` | `websitePostUpdate` | `write_website_post_update` | `PATCH /api/cms/website/drafts/{postId}` |
| `website.product.upsert` | `website` | `websiteProductUpsert` | `write_website_product` | `POST /api/cms/website/catalog` |
| `website.post.publish` | **none** | **none** | **none** | `POST /api/cms/website/drafts/{postId}/publish` |

`website.post.publish` carries a new `alwaysConfirm: true` flag and nothing else: no autopilot
category, no executor, no MCP write tool. Consequences, each pinned by a test:

- `evaluateAutopilotProposal` returns `action_not_eligible` for it **with the category's ceiling
  setting** (`ai-autopilot.test.ts`, "publish ALWAYS needs confirmation").
- `planCoworkerActions` holds it in `auto` mode with a fully open setting (`ai-coworker.test.ts`).
- `assertWriteToolsMatchCatalogue()` stays green — the write list is exactly the executable
  non-coworker-only actions, and publish is not executable (`mcp/tools.test.ts`).
- The eligible-set pin in `ai.test.ts` lists the three drafting actions and not publish.

The sixth autopilot category, `website`, has no Rial ceiling (a draft costs nothing public) and
small counts (defaults 2/run, 2/day; ceiling 5/5). Migration 0136 widens the two CHECK
constraints. The daily autopilot run collects no facts for it (`collectCategoryFacts` default →
skip), so autopilot never *invents* a post on its own; the category exists so a coworker job an
owner wrote — «هر جمعه پیش‌نویس مطلب آیتم‌های تازه» — can run unattended up to the draft.

`app:website` prompt snippet (`ai-prompts.ts`): drafts use real item data read through
`find_items` / `get_menu_item_details`; no invented numbers, prices or claims; a draft stays a
draft; publishing is always the user's explicit confirmation.

## Measurement — five tasks, before and after

Run against the same seeded café with a mock-adapter site. "Before" is the pre-phase website app
(a Payload-specific dialog, no sync, no assistant surface). Steps are what the owner does; the
minutes are wall-clock.

| # | Task | Before | After | What changed |
| --- | --- | --- | --- | --- |
| 1 | Connect the site and know the key works | 6 steps · ~3 min · key stored even when wrong | 4 steps · ~1 min · a wrong key is refused before it is stored | test-before-save; `last_error` on the row |
| 2 | Put 20 menu items on the site with correct prices | 20 × (open dialog, retype name, convert Toman by hand) · ~35 min · 3 price typos | tick 20 boxes, «همگام‌سازی اکنون» · ~2 min · 0 typos | product map + outbox; Rial→site conversion in the adapter |
| 3 | Keep site stock honest after a busy evening (60 sales) | not possible — site stock edited by hand next morning, usually wrong | 0 steps · one `stock.set` per product per tick, quantity read at send | coalescing UNIQUE + read-at-send |
| 4 | Ask the assistant for a "new this week" post | model wrote it in chat with invented prices; owner copied it into the CMS by hand · ~10 min | `website.post.draft` with prices from `find_items` · one confirm · draft lands on the site · ~1 min | read tools + `app:website` rule; draft-only executor |
| 5 | Publish that post | any surface that could write could also publish | only a signed-in person's confirm click; autopilot, coworker and MCP all defer | `alwaysConfirm` — no executor, no category, no MCP tool |

## Exit criteria

| # | Criterion | Where it is met |
| --- | --- | --- |
| 1 | `WebsiteAdapter` interface with mock + Payload providers, integer Rial throughout | `src/lib/website/adapter.ts`, `providers/*`, tests |
| 2 | `website` kind in the hub, owner-only, `integrations`, hub not gated | `connection-kinds.ts` + test, `website-panel.tsx` |
| 3 | Test before save; credential encrypted, never returned | `connection-service.ts` `connectWebsite`, `WebsiteConnectionSummary` |
| 4 | `website_product_map` + `website_outbox` with RLS in the same migration | `0136`; `tenant-isolation.integration.test.ts` green |
| 5 | Both `items` and `menu_items`; coalesced stock; value read at send | `sync-service.ts` `readLocalProduct`, `enqueueWebsiteEvent`, `applyEvent` |
| 6 | `runWebsiteSyncTick()` in `server.ts`, WooCommerce shape, no new bypass reason | `server.ts`, `sync-service.ts` |
| 7 | Opt-in per product, independent price/stock switches, queue page with retry | panel + `/api/connections/website/*` |
| 8 | Three read tools in `toolDefinitions()` and MCP; four catalogue actions | `ai.ts`, `ai-tools.ts`, `mcp/tools.ts` |
| 9 | Publish always confirms, even fully open; `assertWriteToolsMatchCatalogue()` green | `ai-autopilot.test.ts`, `ai-coworker.test.ts`, `mcp/tools.test.ts` |
| 10 | Docs: this file, index row, README section, CLAUDE.md rule | done |

## Files

| Concern | Path |
| --- | --- |
| Migration | `migrations/0136_website_manager.sql` |
| Adapter + providers | `src/lib/website/{adapter,providers/mock,providers/payload,providers/payload-content}.ts` (+ tests) |
| Connection | `src/lib/website/connection-service.ts`, `src/app/api/connections/website/**` |
| Sync | `src/lib/website/{sync,sync-service,catalog-service}.ts`, `sync.test.ts`, `server.ts` |
| Assistant | `src/lib/website/content-service.ts`, `ai.ts`, `ai-tools.ts`, `ai-autopilot.ts`, `ai-autopilot-executors.ts`, `mcp/tools.ts`, `ai-prompts.ts`, `src/app/api/cms/website/{drafts,catalog}/**` |
| Hub | `src/lib/connection-kinds.ts`, `src/app/dashboard/connections/{connections-manager,website-panel}.tsx` |
