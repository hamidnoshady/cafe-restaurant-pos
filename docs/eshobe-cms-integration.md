# Eshobe CMS integration — connecting `cafe-restaurant-pos` to `eshobe-cms` over the API

This app (the Eshobe SaaS platform: POS, accounting, CRM) and
[`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms) (the Payload 3
multi-tenant website platform) are **separate deployments**. This document is
the contract between them and the setup steps for both sides.

## 1. The architecture: headless via REST, tenant from a credential

The CMS resolves the tenant **server-side** from a per-site API key (`Host`
header alone is only valid for anonymous reads on the customer's own domain —
see WAVE-9 §1/§6 in eshobe-cms). An external app never names a tenant in a
query filter.

```
┌─────────────────────────┐          REST + Bearer key          ┌──────────────────────────┐
│  cafe-restaurant-pos     │  ─────────────────────────────────► │  eshobe-cms (Payload 3)   │
│  (POS / accounting /     │   GET  /api/site, /api/pages,       │  one deployment hosts     │
│   CRM — per-business)    │   /api/products, /api/orders …      │  many customer sites      │
│                          │   POST /api/provision-site          │  (per-site domains)       │
└─────────────────────────┘  ◄─────────────────────────────────  └──────────────────────────┘
              ▲   POST /api/cms/revalidate (HMAC-signed) on publish
              └─────────────────────────────────────────────────────┘
```

**Why not embed the CMS in this app?** It is already deployed, multi-tenant,
and ships its own admin. Embedding would duplicate infrastructure, couple
uptime, and re-open the tenant-isolation problem the CMS solved in Wave 9.
The API is the designed interface (WAVE-9.md: "attach by API, or mount the
runtime wholesale").

### Credentials (two kinds, two purposes)

| Key | Role | Issued by | Used for |
|---|---|---|---|
| Site key | `site` | `POST /api/api-keys/issue {siteId, name, role:"site"}` | That one site: pages, posts, products, categories, media, orders (status changes only). Reads include drafts (it is the builder's editor token). |
| Platform key | `platform` | issue endpoint, `{role:"platform"}` | `POST /api/provision-site` and key lifecycle only. **Cannot read site content** (least privilege). |

Both are stored hashed on the CMS (`keyHash` — sha256, never the raw key);
the raw key is shown once at issue time, same pattern as this app's WooCommerce
plugin token.

The POS side stores per-business site keys **encrypted at rest**
(`eshobe_cms_connections`, AES-256-GCM via `src/lib/integrations/secrets.ts`)
and only ever decrypts them inside the outbound HTTP client.

## 2. This repo (the builder side) — what was added

| File | Purpose |
|---|---|
| `src/lib/cms/client.ts` | The only HTTP client for the CMS. Pure URL/header/error core (unit-tested), typed helpers for every endpoint the builder needs (`fetchSiteDescriptor`, `fetchPages/Posts/Products`, `provisionSite`, `issueSiteApiKey`, …). |
| `src/lib/cms/types.ts` | Curated Payload shapes (Site, Page, Post, Product, Order, Media, …). |
| `src/lib/cms/config.ts` | Env contract; `src/lib/cms/connections.ts` resolves the per-business config (domain + decrypted key). |
| `src/lib/cms/webhook.ts` | HMAC verification (`x-eshobe-signature: sha256=<hex>`) + cache-tag derivation. |
| `src/app/api/cms/revalidate/route.ts` | The receiver: verifies the CMS's publish webhook and purges cached CMS data by site tag. |
| `migrations/0122_eshobe_cms_connection.sql` | `eshobe_cms_connections` — one row per business, tenant RLS. |
| `src/lib/website/setup.ts` / `setup-service.ts` | The four-step site-building wizard: the pure step rules (unit-tested) and the `website_setup` row they read and write. |
| `src/lib/website/domain-service.ts` | Buying a domain: price it, refuse early on an empty wallet, order through the CMS's registrar, then bill it here. |
| `src/lib/website/billing.ts` / `billing-service.ts` | What a platform site costs and when the next period falls due; the plan catalogue, the subscription and every charge, settled against the platform wallet. |
| `src/lib/website/managers-service.ts` | Which of the app's two managers this business actually has — one cheap local read the sidebar and the app home both build themselves from. |
| `migrations/0138_website_management.sql` | `website_setup`, `website_service_plans` (global) and the tenant-RLS'd `website_service_subscriptions` / `website_service_charges`; also merges the `wp` app-availability rows into `website`. |

### Environment variables (`cp .env.example .env` / `.env.local.example`)

```
ESHOBE_CMS_URL=https://cms.eshobe.com        # control-plane origin, no trailing slash
ESHOBE_CMS_WEBHOOK_SECRET=<CMS PAYLOAD_SECRET>
ESHOBE_CMS_PLATFORM_API_KEY=                 # optional platform key (provisioning)
```

## 3. Deploying the CMS so the builder can attach

(One-time operator steps in the eshobe-cms repo/deployment.)

1. **DNS**: customer domains → the CMS server; `cms.eshobe.com` (or whatever
   the control plane is) → the CMS. Caddy (in the eshobe-cms repo) serves
   customer domains and the control plane from one deployment, and blocks
   `/api/*` on customer domains by default. This app's client (`src/lib/cms/client.ts`)
   forwards the site's own domain as `Host` on every call, even when the URL it
   dials is the control-plane origin — Caddy's HTTP routing keys on `Host`, not
   on the TLS SNI a `fetch()` negotiates, so a site-scoped call lands on the
   *customer-domain* block regardless of which origin it was dialed through. The
   `@cms_content` carve-out in the CMS's Caddyfile is what lets it through there;
   the application's own access layer (`src/access/siteApiKey.ts`,
   `src/access/siteRead.ts` on the CMS side) is the real boundary, the same trust
   split `/api/site`'s pre-existing carve-out already made. Platform-level calls
   (`provisionSite`, `issueSiteApiKey`, …) carry no `siteDomain`, so they keep
   `Host` as the control plane's own name and need no carve-out at all.
2. **API keys (CMS side)**: the WAVE-9 §9.4 feature is delivered by
   `eshobe-cms-api-keys.patch` (see §5). After applying it:
   - `pnpm install && pnpm generate:types && pnpm typecheck && pnpm test:int`
   - Issue keys: `POST /api/api-keys/issue` (platform-admin session or a
     platform key).
3. **Revalidation webhook**: on the CMS set
   `REVALIDATE_WEBHOOK_URL=https://<this-app>/api/cms/revalidate`.
   The secret it signs with is the CMS's `PAYLOAD_SECRET` — put the **same
   value** in `ESHOBE_CMS_WEBHOOK_SECRET` here.
4. **CORS**: not needed for server-to-server calls (CORS is browser-only).
   Leave `API_CORS_ORIGINS` unchanged unless a browser client is added.

## 4. Using the connection from app code

```ts
import { getCmsConfigForBusiness } from "@/lib/cms/connections";
import { fetchSiteDescriptor, fetchProducts, updateOrderStatus } from "@/lib/cms/client";

// Inside a request scoped to a business (RLS is already applied by the pool):
const cms = await getCmsConfigForBusiness(businessId);   // throws if not connected
const site = await fetchSiteDescriptor(cms);             // theme, locales, store
const products = await fetchProducts(cms);               // the site's catalogue
await updateOrderStatus(cms, orderId, "paid");           // e-commerce ops
```

- **Never** pass `where[site][equals]` to choose a tenant — the key does it.
- Prices are integers in the site's minor currency unit — format with the
  site's currency, never convert Toman↔Rial client-side.
- Media URLs: `absoluteCmsMediaUrl(media, site.media.origin)` — the stored
  `url` is often relative and must resolve against the *site's* origin.
- All calls are server-side; never put a raw site key in a browser bundle.

### Connecting a business (flow)

1. Provision the website for the business: `provisionSite(platformConfig, input)`
   (platform key) → returns `site.id`, `site.domain`, `site.url`.
2. Issue its site key: `issueSiteApiKey(platformConfig, { siteId, role: "site" })`
   → raw key returned once.
3. Store both: `saveCmsConnection({ businessId, siteId, siteDomain, baseUrl, apiKey, keyName })`.
4. From then on everything uses `getCmsConfigForBusiness(businessId)`.

## 5. «مدیریت وب‌سایت» — one app, two managers

The owner/manager surface is **one app** (`/dashboard/website`, «مدیریت
وب‌سایت», `src/lib/apps.ts`) with two managers inside it, and the distinction
matters in both directions:

* **سایت‌ساز اشوبه** (`/dashboard/website/cms/*`) — this document's subject: the
  platform site, on eshobe-cms.
* **وردپرس و ووکامرس** (`/dashboard/website/wp/*`) — a WordPress site the
  business already runs (Phase 40; it moved here from `/dashboard/wp`, which
  now redirects).

They are peers and never fold into each other: separate connections, separate
sections, separate headers. What they share is one door in the rail and one
sidebar, whose menu is built from the business's **real connections**
(`GET /api/website/managers`) — a manager with no connection lists only its
front page and the screen that connects it, so there is never a «سفارش‌ها»
entry over a site that does not exist.

The `integrations` entitlement gates the WordPress half only
(`/dashboard/website/wp` in `features.ts`): a business without the add-on
still reaches the platform site it pays for.

### The CMS manager's sections

| Section | Route | What it is |
|---|---|---|
| میز کار سایت | `/dashboard/website/cms` | Connection, the DNS checklist and the live preview. |
| ساخت سایت | `…/cms/setup` | The four-step wizard (below). |
| محتوا | `…/cms/content` | The site's pages and posts. |
| فروشگاه | `…/cms/store` | Products and the orders the site took. |
| تنظیمات و همگام‌سازی | `…/cms/settings` | The connection itself, and the one-way price/stock push (Phase 38w; this section is where the connections hub's «وب‌سایت» tab moved). |
| اشتراک و صورت‌حساب | `…/cms/billing` | What the site costs and what it has cost. |

### Building a site: domain → CDN → type → build

«سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The wizard
(`src/lib/website/setup.ts`, `website_setup`) walks the four steps in the order
an owner works in, saving each answer as it is given so it can be abandoned on
a phone and finished on a desk. Which step is "current" is never stored twice —
it is derived from the answers.

1. **دامنه.** Either the business owns the domain and will point DNS at the
   platform, or the platform's registrar registers it. A quote
   (`GET /api/cms/website/domain/quote`) has no side effects and needs no site,
   which is why it can be asked at step one — the CMS accepts a *platform* key
   for the quote alone. An order (`POST …/domain/order`) is site-key work and
   is priced, wallet-checked, placed and *then* billed, in that order: charging
   first would need a refund path that only runs on failure.
2. **CDN.** ArvanCloud in front of the site, or a recorded «بدون CDN» — saying
   no is a decision the wizard keeps, not a step it drops. Creating the zone is
   platform-staff work on the CMS; the business sees its own zone through
   `GET /api/cms/website/cdn` and can empty its own cache.
3. **نوع سایت.** معرفی کسب‌وکار / نمونه‌کار / فروشگاه, plus a name and the plan
   the site will run on. This is what `POST /api/provision-site` is told, so it
   decides the new site's blocks and starter content.
4. **ساخت.** Provision on the CMS → issue the site key → store it encrypted →
   start the subscription, in that order. A business is never billed for a site
   whose provisioning failed; the reverse (a site with nothing billing for it)
   is recoverable by the operator, so that is the direction the failure falls.

### Who bills for the site

The CMS renders and serves; it has no wallet, no plan and no invoice. Every
Rial — the monthly site fee, a domain registration or renewal, a one-off setup
— is a `website_service_charges` row settled against the **same platform wallet**
the assistant and messaging draw on (migration 0130), so one top-up covers all
three. Two rules carry it:

* **Idempotency is the UNIQUE index** `(business_id, kind, reference)`. A
  subscription charge's reference is the period it covers, never the moment the
  tick ran, so a retry or a second replica cannot bill twice.
* **A wallet that cannot cover a renewal marks the subscription `past_due` and
  leaves the site serving.** `runWebsiteBillingTick()` (hourly, on the custom
  server) never cuts a shopfront off; the owner sees the state and a
  «پرداخت دورهٔ جاری» button on the billing section.

A quote in a currency this app cannot express in Rial is **refused** rather than
converted at a guessed rate (`quoteToRial`): charging a business a number nobody
can reconcile is worse than saying the platform cannot sell that TLD yet.

### The API surface

| Route | What it does |
|---|---|
| `GET /api/cms/website/state` | Masked connection state (never the key). |
| `POST /api/cms/website/connect` | Attach an existing site (probe descriptor → store key encrypted). |
| `POST /api/cms/website/provision` | Create a new site + issue its key + connect, in one action. |
| `DELETE /api/cms/website/connection` | Disconnect (the CMS site and its content remain). |
| `GET /api/cms/website/overview` | Descriptor + pages + posts + products + orders (private, 30s SWR). |
| `GET /api/cms/website/dns` | DNS checklist state: does the domain resolve to the CMS (A/AAAA from here) + descriptor `domainVerified`. |
| `POST /api/cms/website/posts`, `PATCH`/`DELETE /api/cms/website/posts/[id]` | Create/edit/delete a post. Always lands as a draft — a site key can never publish over the API (`writeUnlessPublishing`); publishing is a CMS-admin action. |
| `POST /api/cms/website/products`, `PATCH`/`DELETE /api/cms/website/products/[id]` | Create/edit/delete a product. Same draft-only rule. |
| `PATCH /api/cms/website/domain` | Move the connected site to a new domain (`updateSiteDomain` → CMS `PATCH /api/site/domain`, site-key only). Resets `domainVerified` server-side and updates the stored `site_domain`; the DNS checklist has to be re-run and the CMS-side box re-ticked. |
| `PATCH /api/cms/website/orders/[id]` | Move an order status; the CMS settles stock & snapshot. |
| `GET`/`PATCH /api/cms/website/setup` | The wizard's state (plus the plan catalogue); record one step's answer. |
| `POST /api/cms/website/setup/build` | Step 4 — provision, connect and subscribe. Owner only. |
| `GET /api/cms/website/domain/quote` | Price a domain, with the wallet balance beside it. No side effects, no site required. |
| `POST /api/cms/website/domain/order` | Buy/transfer/renew through the CMS's registrar and bill it here. Owner only. |
| `GET /api/cms/website/cdn`, `POST …/cdn/purge` | The site's own CDN zone, and emptying its own edge cache. |
| `GET /api/website/managers` | Which of the app's two managers this business has — what the sidebar and the app home are built from. |
| `GET`/`POST /api/website/billing` | Plan, subscription and charges; start/change a plan, pay the current period, stop auto-renewal. |

Pages stay read-only from this app — the block-based page builder is a CMS-admin surface, deliberately not duplicated here. «مدیریت محتوا در CMS» keeps that door open for anything this screen doesn't cover (page layout, media, nav, forms, publishing).

### DNS checklist + live preview

The Website Manager shows a three-step checklist («دامنه و انتشار سایت»):
1. A/CNAME record for the customer domain exists — checked by resolving the
   domain from this server (the same resolver family browsers use).
2. It points to the CMS server — the resolved addresses overlap the CMS
   origin's addresses (`src/lib/cms/dns.ts`).
3. The operator has ticked **تأیید دامنه** in the CMS admin — read from the
   site descriptor (`domainVerified`, added to `/api/site` by the patch).

Once all three are green, an **in-app iframe preview** of the live site is
shown (`https://{domain}/`). Since the CMS's site pages send
`frame-ancestors 'self' <admin>` CSP, the POS origin must be added on the CMS:

```
# eshobe-cms .env — comma-separated origins allowed to frame customer sites
SITE_PREVIEW_ORIGINS=https://pos.eshobe.com
```

(The patch extends that header from this env var; empty = admin origin only,
the previous behaviour. Note: the CMS's own `/api/domain-check` is
Caddy-internal and answered 404 publicly, so the builder deliberately uses
DNS resolution + `domainVerified` instead of it.)

All owner/manager, all server-side — the browser never sees a CMS key.
On the CMS, the site descriptor (`GET /api/site`) also returns `id` so the
connect flow can record which site the key belongs to.

## 5. The CMS side (WAVE-9 §9.4, `eshobe-cms`)

Landed directly in the `eshobe-cms` repo (not a patch to apply):

- `src/lib/api-keys.ts` — pure key generation/hashing (`eshobe_live_…`, sha256,
  a bearer-token parser). Framework-free, like `src/lib/slug.ts`.
- `src/collections/ApiKeys.ts` — the credential collection (platform-admin
  only; deliberately **not** in the multi-tenant plugin's `collections` map).
  A `beforeValidate` hook mints the key on create and stashes the raw value on
  `req.context` for the issuing endpoint to return exactly once.
- `src/access/siteApiKey.ts` — key resolution (`Bearer eshobe_live_…` → sha256
  lookup → site, memoised per request like `siteRead.ts`'s `Host` lookup) and
  the access wrappers every collection composes: `apiKeyAware` (read — a site
  key sees its own site's drafts too), `apiKeyCreateAware`/`apiKeyUpdateAware`
  (write — site-scoped, never a publish), `platformApiKeyAware` (`sites`'
  own read, `provision-site`), `forceApiKeySite` (a `beforeChange` hook that
  overwrites `data.site` with the key's own site — access only checks a valid
  key exists, this is what stops it naming a *different* site in the payload).
- `src/collections/hooks/restrictApiKeyOrderWrite.ts` — a site key's one order
  write is a status transition; every other field reverts to what the document
  already held.
- `src/endpoints/apiKeys.ts` — `POST /api/api-keys/issue`,
  `GET /api/api-keys/list`, `POST /api/api-keys/revoke` (platform-admin
  session or a platform key).
- Access wiring: `pages` read only (page layout stays a CMS-admin surface —
  see §5 below); `posts` and `products` read/create/update/delete, always
  draft-only on a key-authorized write (`apiKeyCreateAware`/
  `apiKeyUpdateAware` refuse `_status: "published"` — no key can publish);
  `orders` read/update (status only); `sites` read accepts a platform key
  too. `categories`/`media`/`store` needed no change — already host-scoped
  public reads with no draft state, which a site key's forwarded `Host`
  already satisfies.
- `src/endpoints/siteDescriptor.ts` (`GET /api/site`) falls back to a site
  key when `Host` resolves nothing — the case WAVE-9 names explicitly
  ("a builder can call from a non-customer origin"); the fallback response is
  never publicly cached (`cache-control: private, no-store`), unlike the
  `Host`-resolved one. The response's `id` and `domainVerified` fields are
  **only** included on that key-resolved, private response — never on the
  public `Host`-resolved one (`tests/int/headless.int.spec.ts` pins the
  omission), since both are internal to the site's own builder.
- `src/endpoints/updateSiteDomain.ts` (`PATCH /api/site/domain`) — the one
  write path onto `Sites` a credential can reach at all: `Sites.access.update`
  stays `authenticated` (admin-session only) for everything else. Site-key
  only, resets `domainVerified` to `false` on every change, and refuses a
  domain already in use by another site.
- `src/provisioning/provisionSite.ts` and `provisionSiteEndpoint` accept a
  platform key alongside a platform-admin session, at both the endpoint guard
  and the service function's own re-check.
- `Caddyfile` — a `@cms_content` carve-out for `/api/{pages,posts,products,
  categories,store,orders}` on the customer-domain block, and a separate
  `@site_domain` carve-out (`PATCH /api/site/domain` only) for the endpoint
  above. This app's client forwards a site's domain as `Host` even when
  dialing the control-plane origin (see §1 above), which routes there rather
  than to the control-plane block; the application's access layer is the real
  boundary, the same trust split `/api/site`'s pre-existing carve-out already
  made.
- `next.config.ts` — `SITE_PREVIEW_ORIGINS` extends the `frame-ancestors` CSP
  so this app's live-preview iframe (§"DNS checklist + live preview" above) is
  allowed to frame a customer site.

After pulling these changes:

```bash
pnpm install
pnpm generate:types   # adds the ApiKey interface to payload-types.ts
pnpm payload migrate:create add-api-keys   # dev uses push; prod needs the migration
pnpm typecheck && pnpm test:int
```

Security properties this keeps: a key never names a tenant (the payload's
`site` is overwritten on create); a key is confined to one site on reads and
updates; revoking is immediate (`disabledAt`); platform keys cannot read or
write site content; the raw key is never stored and never
returned twice.

## 6. Failure handling

- The client throws `CmsApiError` (HTTP 4xx/5xx with the Payload error body)
  or `CmsNetworkError` (timeout/DNS — default 8s timeout).
- Reads are best-effort by design: a down CMS never takes the POS down.
  Callers should fall back to cached/last-known data (the webhook + cache
  tags make staleness bounded), and a **write** must never be reported as
  applied unless the CMS answered 2xx.
- Webhook verification failure returns 401 and purges nothing — an
  unauthenticated cache purge is a DoS button.
