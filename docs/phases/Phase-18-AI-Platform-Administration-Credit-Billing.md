# Phase 18 — AI Platform Administration & Credit Billing

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 15 (Super-Admin Console), Phase 17 (Feature Gating & Platform Hardening), and
the AI assistant baseline (`src/lib/ai.ts`, `ai-config.ts`, `ai-service.ts`, `ai-tools.ts`,
`src/components/ai/ai-assistant.tsx`, `/dashboard/ai`) — that baseline shipped without a phase doc of
its own; this phase is also where that gap gets closed.
**Goal:** The AI assistant becomes a platform-run, metered service instead of a per-business
bring-your-own-key toggle: one operator-owned provider connection serves every business, a platform
admin decides which businesses have it and how much they can use, and a business tops up its own
usage against a priced package.

---

## Context: what exists today

The assistant (floating chat widget, wizard/dashboard modes, `propose_action` confirm-before-apply
loop) is real and working, but its access model is entirely per-business self-service: each business's
owner/manager opens `/dashboard/ai`, picks a provider (OpenRouter or ArvanCloud AI), and pastes in
their own API key, stored under that business's `settings` row (`ai.config`). The only platform-level
control that already touches it is generic: `ai_assistant` is one row in the Phase 12 `feature_flags`
catalogue, so a platform admin can already flip it on/off per business from the existing
`business_features` override mechanism (Phase 15's "Feature flags & plans" console, enforced by Phase
17's `withTenantScope` gate). There is no metering, no shared provider, and no billing — Phase 15
explicitly put "billing, invoicing, payment collection" out of scope at the time ("plans are assigned
by hand").

This phase reverses that scoping decision, but only for AI usage specifically — everything else about
plan assignment stays hand-assigned, unchanged.

## Scope

- **Single global provider connection.** Provider, model, base URL, API key and temperature move from
  a per-business `settings` row to one platform-owned config, used by every business's assistant calls.
  No business ever sees or sets a key again.
- **A dedicated `/platform/ai` console section** — provider connection, credit packages/pricing,
  per-business subscription + balance + manual credit grants, pending top-up requests, and
  cross-business usage analytics (tokens/credits consumed, busiest businesses). This is the "section
  for managing all AI features and management" the product owner asked for — one place, not scattered
  across existing pages.
- **Per-business enable/disable** stays on the existing `ai_assistant` feature-flag override (it
  already does exactly this job) — this phase surfaces that same toggle inside `/platform/ai` next to
  the new credit/subscription controls, rather than building a second on/off mechanism.
- **Credits, pricing, subscriptions, top-up.** A priced catalogue of credit packages; a business can
  hold an optional subscription plan (recurring monthly credit grant) and/or a manually topped-up
  balance; every assistant call debits the business's balance by its actual usage; a business with a
  depleted balance gets a clear blocked-state message instead of a provider call.
- **Business-facing `/dashboard/ai` is repurposed**, not removed: it drops the provider/model/key form
  entirely and becomes a credits page — current balance, active subscription (if any), recent usage,
  and a "request top-up" action against the priced packages.

## Out of scope

- Live payment-gateway integration (Zarinpal/IDPay/etc.) — V1 top-up is a request-and-admin-approves
  flow (see Decision 5). Wiring a real gateway is a fast-follow once one is chosen.
- Per-model differentiated pricing, promotional discounts, proration, and refunds.
- Multi-currency — pricing is Toman-displayed / integer-Rial-stored, same as everywhere else in the
  app.
- Re-litigating hand-assigned business *plans* (`plans` table, Phase 17) — this phase adds a parallel,
  AI-specific subscription concept; it doesn't touch branch/member/order plan limits.

## Exit criteria

- A platform admin can set one provider/model/key/temperature that every business's assistant calls
  use; no business-facing UI or API response ever exposes that key.
- Disabling `ai_assistant` for a business blocks it exactly as it does today (nav, page, API); a
  business at zero credit balance is blocked the same way, with a distinct "top up" message rather than
  "not configured."
- A platform admin can grant credits and assign/change an AI subscription plan for one business,
  visible only in that business's own dashboard (tenant isolation holds for every new table).
- Every assistant turn debits the calling business's balance by its actual usage; a turn is refused
  before it reaches the provider if the balance can't cover it.
- A business can see its own balance, usage history, and active subscription, and can submit a
  top-up request against a priced package; a platform admin can see and act on pending requests.
- The new tenant-scoped tables (business balance, ledger, top-up requests) pass the generated
  isolation test from Phase 17 (`tenant-isolation.integration.test.ts`) the same way every tenant table
  must; the new global catalogues (provider config, credit packages, AI subscription plans) are
  explicitly exempt, the same way `plans` and `feature_flags` already are.

## Decisions

1. **No new `withoutTenantScope` category is needed.** Platform writes to a specific business's credit
   balance/ledger/subscription use the same already-justified "platform administration" reason
   `platform-service.ts` uses today for feature-flag overrides and plan assignment — an explicit
   `businessId` parameter, not a caller's own tenant session (there isn't one). The assistant's own
   usage-debit write happens inside the ordinary `requireManager` + `withTenantScope` request path
   (`/api/ai/chat`), so it needs no bypass at all. The one background job this phase adds — monthly
   subscription renewal — follows the repo's existing rule for background work: enumerate businesses
   under a bypass, then wrap each business's own credit grant in `withTenant(businessId, …)`.

2. **Credits are a display unit, not a second currency.** The project's money convention (integer
   Rial storage, Toman display) is load-bearing and this phase doesn't carve out an exception: the
   ledger and balance are stored in integer Rial internally, and "credits" are purely a fixed-rate
   label the UI shows (e.g. 1 credit = a fixed Rial amount set once in the provider config) so the
   packages read like a normal SaaS credit bundle without inventing a parallel accounting unit that
   the existing reporting/ledger code doesn't know how to handle.

3. **Per-business enable/disable reuses the existing feature flag, not a second flag.** Building a
   separate `ai_enabled` column on the new billing table would create two sources of truth for "can
   this business use the assistant." `/platform/ai`'s per-business panel writes the same
   `business_features` override the generic console already does (Phase 15/17); the assistant route
   checks the flag exactly as it does today, and *additionally* checks credit balance — an off flag and
   a zero balance both block, with different messages, but neither introduces a new gating mechanism.

4. **The global provider config is a singleton catalogue table, not a `settings`-row hack.** Modelled
   like `plans`/`feature_flags` (Phase 12/17): no RLS, one row, read by every business's assistant call,
   written only through `/platform/ai` under a new owner-only capability (it holds a real API key — the
   same class of secret as `updates.manage`'s S3 credentials in `platform-admin.ts`). Per-business
   `ai.config` settings and the existing `/dashboard/ai` provider form are removed in the same change,
   not deprecated-and-left — a second, now-unused key-entry path is a real support risk (someone types
   a key that nothing reads).

5. **Top-up is a request-then-approve flow in V1, not a live payment gateway.** Nothing in this repo
   integrates a payment provider today, and picking one (and its fee/webhook/reconciliation model) is
   a product decision, not an implementation detail this phase should guess at. A business submits a
   top-up request (package + note) from `/dashboard/ai`; it lands in `/platform/ai`'s pending-requests
   list; a platform admin marks it fulfilled, which posts the credit grant to the ledger. This keeps the
   feature usable immediately (manual bank transfer is already how many Iranian SMBs pay for
   subscriptions) while leaving room to wire a real gateway later without changing the ledger/balance
   model underneath it.

6. **New platform capabilities, split by blast radius like every other one in `platform-admin.ts`:**
   `ai.read` (usage, balances, pending requests — all three existing roles' read tier), `ai.credits.manage`
   (grant credits, assign a subscription, approve/reject a top-up request — operational and reversible,
   so `engineer` + `owner`, the same tier as `business.suspend`), and `ai.config.manage` (the provider
   connection and the credit-package/subscription-plan pricing catalogue — holds a real secret and sets
   real pricing policy, so `owner`-only, the same tier as `updates.manage`).

7. **A subscription is a recurring monthly credit grant, not a separate spending bucket.** Keeping one
   balance per business (subscription renewals and manual top-ups both post to the same ledger) avoids
   "which bucket drains first" logic nobody asked for; a subscription plan is just a catalogue row
   (`monthly_credits`, `price_toman`) and a renewal-date column on the business's billing row that a
   scheduled job grants against on its date, same balance either way.

## Resolved implementation decisions

1. **V1 top-up remains request-then-approve.** No payment gateway was guessed or added. A business chooses a platform-priced package and may include a transfer/reference note; an engineer or owner approves or rejects it in /platform/ai. Approval posts the credit through the same immutable ledger path as a manual grant.

2. **No sample price is seeded.** The platform owner creates the real priced packages and subscriptions in /platform/ai before offering them. This avoids treating guessed Iranian pricing as production financial data while still delivering a complete catalogue, request, approval and ledger workflow.

3. **Balances never go negative.** Each assistant turn atomically reserves the platform-configured maximum before any provider call. Provider usage is settled to its actual input/output-token cost and unused reservation is refunded. A business unable to cover the reservation is blocked before a provider request.

4. **Suspended businesses cannot drain AI credit.** The existing requireManager/tenant guard blocks suspended memberships before /api/ai/chat reaches the billing reservation. No parallel suspension switch was introduced.

## Implementation map

- migrations/0039_ai_platform_billing.sql creates the singleton provider config, global catalogues, tenant-scoped billing/ledger/top-up tables, forced RLS policies, and removes obsolete settings.ai.config rows.
- src/lib/ai-config.ts, src/lib/ai-billing.ts, src/lib/ai-billing-service.ts, and src/lib/ai-service.ts provide the global connection, actual-usage settlement, atomic reservation/refund, top-up approval, and monthly subscription renewal.
- /platform/ai and /api/platform/ai are the capability-gated platform console/API. ai.read covers analytics, ai.credits.manage covers grants/subscriptions/reviews, and ai.config.manage is owner-only for secrets and pricing.
- /dashboard/ai and /api/ai/billing are business-facing credits surfaces only. Provider/model/key inputs are removed; no business API response includes them.
- server.ts runs the idempotent monthly-credit renewal tick, and the RLS/exempt-table tests cover the new schema classes.

## Status: implemented

The Phase 18 code is complete pending the standard migration, unit, integration, type-check, and production-build verification. Before enabling the service in production, the platform owner must enter the real provider connection/rates and create the intended credit packages/subscription plans in /platform/ai.
