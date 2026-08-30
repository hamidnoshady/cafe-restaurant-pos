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
   customer domains and the control plane from one deployment; it already
   blocks `/api/*` on customer domains — check the Caddyfile so the control
   plane is the only origin that serves the API.
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

## 5. The CMS-side patch (`eshobe-cms-api-keys.patch`)

Slice 9.4 as implemented against the eshobe-cms main branch:

- `src/access/siteApiKey.ts` — key resolution (`Bearer eshobe_live_…` →
  sha256 lookup → site), access wrappers (`apiKeyAware`, `apiKeyCreateAware`,
  `platformApiKeyAware`, `forceApiKeySite`), issued by `api-keys` rows.
- `src/collections/ApiKeys.ts` — the credential collection
  (platform-admin only; deliberately **not** in the multi-tenant plugin map).
- `src/endpoints/apiKeys.ts` — `POST /api/api-keys/issue`,
  `GET /api/api-keys/list`, `POST /api/api-keys/revoke` (platform auth).
- `src/access/siteRead.ts` — an API key now supplies the tenant where the
  `Host` would have, and key holders see drafts; platform keys denied.
- Access wiring on `pages`, `posts`, `products`, `categories`, `media`,
  `orders`, `sites` + `POST /api/provision-site` accepts a platform key.

Apply with `git apply ~/eshobe-cms-api-keys.patch` (or cherry-pick the
commits from the session branch), then:

```bash
pnpm install
pnpm generate:types   # adds the ApiKey interface to payload-types.ts
pnpm payload migrate:create ApiKeys   # dev uses push; prod needs the migration
pnpm typecheck && pnpm test:int
```

Security properties the patch keeps: a key never names a tenant (the payload's
`site` is overwritten on create); a key is confined to one site on reads,
updates and deletes; revoking is immediate (`disabledAt`); platform keys
cannot read or write site content; the raw key is never stored and never
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
