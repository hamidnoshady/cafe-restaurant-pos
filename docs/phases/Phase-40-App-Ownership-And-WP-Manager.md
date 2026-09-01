# Phase 40 — app ownership boundaries, Growth customer projection & WP Manager

This phase makes the app boundaries explicit after the product grew several
systems that consume one another's data. It covers two related corrections:
Accounting's customer workflow now opens in Growth, and WordPress/WooCommerce
management is a standalone WP Manager app rather than a connection section of
Accounting or the generic technical Connections app.

## The product rule

Each app owns the system and features that make up that app. A consuming app may
read or synchronise only the data needed for its own workflow. Consumption does
not transfer ownership, create a second canonical table, or justify a second
edit path.

`src/lib/app-data-rules.ts` is the framework-free contract for this rule:

| Domain | Canonical owner | Readers/use in their own workflow | Boundary |
| --- | --- | --- | --- |
| `customer_records` | CRM | Sales, Growth, Accounting, Operations, WP Manager | shared service |
| `sales_documents` | Sales | Accounting, Growth, CRM, WP Manager | shared service |
| `ledger_entries` | Accounting | Sales, Growth, CRM, WP Manager | shared service |
| `growth_programs` | Growth | Sales, Accounting, CRM | shared service |
| `operations_catalogue` | Operations | Sales, Accounting, WP Manager | shared service |
| `wp_store_mirror` | WP Manager | Sales, Accounting, Growth, CRM, Operations | mapped integration |
| `website_content` | Website | Sales, Growth | mapped integration |
| `technical_connections` | Connections | WP Manager | mapped integration |

An app may write a canonical domain only through its owner (`canWriteData`).
The WP Manager owns the local mapped store mirror; WordPress/WooCommerce remains
the authority for the remote store. Other apps may use the mirror or shared
service, but do not acquire WordPress management screens or a competing store
system.

## Accounting customer workflow → Growth

The Accounting A/R surfaces continue to own and calculate receivables. Their
customer actions now link to `/dashboard/growth/customers`, including an
optional `customerId` when opening a particular A/R statement. Growth displays a
read-only customer projection for growth workflows and reads the shared customer
service; it does not create or edit a customer record.

The canonical record and full customer file remain in CRM. Growth rows link to
`/dashboard/crm/customers/[id]` for edits and the full 360-degree file. The legacy
`/dashboard/customers` route continues to redirect to the CRM directory for old
bookmarks. Accountant access is limited to the Growth customer projection, not
the Growth dashboard, campaigns, loyalty controls or commission data.

This gives Accounting a direct path to the app where the requested customer
workflow opens without making Growth or Accounting the source of truth for the
customer record.

## WP Manager is a standalone app

The WP Manager is registered as `wp` and owns `/dashboard/wp` plus these sections:

- connection and link-mode setup (`/dashboard/wp/connections`);
- product catalogue and supported WooCommerce operations;
- store orders and selected status/refund operations;
- mirrored store customers, linked to CRM records for canonical customer work;
- WooCommerce taxonomies;
- WordPress posts, pages and media;
- the inbound/outbound sync queue and operational status.

Its complete app shell, navigation and connection panel live under
`src/app/dashboard/wp`. The WooCommerce panel and store operation components no
longer come from the generic Connections implementation. The WP connection
picker and read models are provider-scoped to WooCommerce, so a Holoo
connection cannot appear as a WordPress store or be used by a WP workflow.

The old `/dashboard/integrations` route redirects to the WP Manager connection
screen. The old `/dashboard/connections?tab=woocommerce` URL does the same. The
technical Connections app at `/dashboard/connections` contains desktop pairing,
Holoo, API keys and MCP only; its compatibility catalogue may still recognise
the old WooCommerce key, but it never renders it.

The `integrations` feature entitlement is applied once at the WP app boundary as
a locked preview. Role and tenant checks remain on every WP Manager API route,
and WP-specific read models additionally verify the WooCommerce provider.

## Navigation and route ownership

The app registry assigns `integrations` to WP Manager and `connections` to the
technical Connections app. The industry profile, app-shell registry and app
availability tests map the two route families separately:

- dashboard: `/dashboard/wp/*` → WP Manager;
- dashboard: `/dashboard/connections` → Connections;
- API read models: `/api/integrations/wp-manager/*` → WP Manager.

Both apps are independent launchers in the workspace rail and independent
entries in the classic dashboard navigation. Neither is presented as an
Accounting section.

## Exit criteria

- [x] A/R customer links open the Growth customer projection, with an optional
      selected customer, while CRM remains the canonical record owner.
- [x] The ownership contract names one owner per cross-app data domain and
      rejects writes by non-owners in unit tests.
- [x] WP Manager has its own shell, navigation, connection route and selected
      WooCommerce management workflows.
- [x] Generic Connections no longer renders WooCommerce; old WooCommerce URLs
      redirect to WP Manager.
- [x] WP Manager connection lists and read models are restricted to WooCommerce
      providers, not other technical integrations.
- [x] The TypeScript check and targeted ownership, app-shell, availability,
      connection-kind and Growth navigation tests pass.

## Deliberate non-goals

- Moving CRM ownership into Growth or WP Manager.
- Copying ledger, customer, sales or operations systems into another app.
- Removing the underlying shared integration services: app ownership is a
  product/navigation boundary, not permission for callers to fork adapters or
  duplicate sync logic.
