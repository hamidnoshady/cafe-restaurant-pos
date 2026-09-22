# AI Billing Architecture — the single-billing cutover (migration 0168)

> Status: implemented. This document is the contract the code now enforces;
> the tests that pin it are `integration/ai-billing-flow.integration.test.ts`
> (the money story), `integration/ai-virtual-key-provisioning.integration.test.ts`
> (the identity-only key mint) and `src/lib/ai-gateway.test.ts` (the pure half).

## The one-sentence rule

**The platform wallet (`business_wallets`) is the single billing stop for every
AI turn, a plan's «اعتبار ماهانهٔ هوش مصنوعی» is real spendable credit that the
settlement consumes before the wallet, and the LiteLLM virtual key is an
identity — it mirrors no budget, no rate limit and no model list.**

## The money story of one turn

```
tenant request (chat / estimate / vision / ocr / rag / media)
  │
  ├─ resolveAiConfigFor(businessId, locationId, { ensureVirtualKey: true })
  │     └─ lazily mints the business key when virtual keys are on        (ai-runtime.ts)
  │
  ├─ checkAiAffordability(businessId, maxTurnRial)                       (wallet-service.ts)
  │     ├─ reconcileAiDebtTx: any balance pays down AI debt first
  │     └─ affordable ⇔ debt ≤ 0 AND balance + allowanceRemaining ≥ ceiling
  │           402 ai_credit_required ← the ONLY pre-request money gate
  │
  ├─ provider call through the gateway (ai-service.ts)
  │     ├─ 429 → ai_rate_limited («پرکاربرد است؛ کمی بعد…»)
  │     └─ failure → no settlement call at all — the wallet is untouched
  │
  └─ settleAiWalletCharge({ requestId, chargedRial, … })                 (wallet-service.ts)
        ├─ idempotent by (business_id, request_id) — retries are no-ops
        ├─ allowanceAppliedRial = consumePlanAllowanceTx(cost)   ← allowance FIRST
        ├─ walletCost = cost − allowanceAppliedRial
        ├─ debitedRial  = min(walletCost, balance)               ← one ledger row
        ├─ debtAddedRial = walletCost − debitedRial              ← never hidden
        └─ charged_rial = FULL cost on the settlement row
```

### What each number means

| Field | Meaning |
|---|---|
| `chargedRial` (settlement) | The full settled cost of the turn — provider cost + platform margin. Never discounted. |
| `allowanceAppliedRial` | The part the plan's monthly credit covered. Recorded in the settlement metadata and (when the wallet was also debited) the wallet ledger metadata. |
| `debitedRial` | What actually left the wallet. A fully allowance-covered turn debits **0** and writes **no** wallet ledger row — the allowance row is the record. |
| `debtAddedRial` | A post-request cost the wallet could not cover. Booked in `ai_wallet_debt`, shown in the console, blocks the next turn until a recharge pays it down. |
| `feature_usage.spent_rial` | Wallet money only (`debitedRial`) — usage reporting and the wallet agree by construction. |

### The affordability gate

The gate runs BEFORE the request and uses the configured per-turn ceiling
(`maxTurnRial`) as a minimum-cover guard:

- **debt must be 0** — a business carrying AI debt is blocked at the door, and
  any balance it does have is applied to the debt inside the same locked
  transaction;
- **balance + allowanceRemaining ≥ ceiling** — so a business on a plan with
  credit may start a turn with an *empty wallet*, as long as the month's
  unused allowance covers the ceiling. Plan credit is spendable credit, not a
  hint.

The refusal is the one code `ai_credit_required` with the message
«اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید.».

## The plan allowance (Plan Builder's «سقف هوش مصنوعی این پلن»)

- `billing_plans.monthly_ai_credit_rial` — NULL means "no included credit"
  (0 normalises to NULL on save; an update can therefore *clear* the credit).
- One usage row per (business, calendar month) in `ai_plan_allowance_usage`.
  The month key is computed in **Asia/Tehran** (`periodMonthFor`), so an
  Iranian business's month flips at the Iranian midnight.
- `granted_rial` snapshots the plan's allowance at the month's first use; the
  effective cap for the rest of the month is `min(granted_rial, plan's current
  value)` — **lowering a plan bites immediately, raising it only next month,
  and history is never rewritten.**
- Consumption happens INSIDE the wallet settlement's locked transaction
  (`consumePlanAllowanceTx`); it needs no lock of its own because every writer
  already holds the per-business `business_wallets` lock.

## What the gateway key is — and is not

`provisionVirtualKey` mints a LiteLLM virtual key whose body is exactly:

```json
{ "key_alias": "pos-<business>", "metadata": { "business_id": "…", "source": "cafe-pos" } }
```

- **No `models` allowlist** — changing the platform's chat alias must not
  orphan every existing key against the new model. Model choice is the request
  path's decision (`resolveChatModel`), not the key's.
- **No `max_budget` / `budget_duration` / `tpm_limit` / `rpm_limit`** — those
  are LiteLLM's to enforce *for its own reasons* (configured in
  `docker/litellm/config.yaml`), never mirrored from the platform. A mirrored
  key budget used to 429 tenants whose Rial wallet still had credit; that
  double-gate is gone.
- Keys are minted **lazily** (`ensureTenantVirtualKey`) on the first request
  that authenticates as the business; console read paths never mint. A branch
  key is optional and rides the business key when absent.
- Console `sync_key` pre-flights `ai_gateway_disabled`,
  `ai_gateway_missing_master_key`, `ai_gateway_virtual_keys_disabled` (400) and
  maps `GatewayProvisioningError` → 502 with the proxy's own detail.

## Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Rial billing, affordability, debt, allowance | `wallet-service.ts` + `ai-plan-allowance.ts` | The single stop. |
| Routing strategy, per-model RPM/TPM, per-key budgets | `docker/litellm/config.yaml` | The platform console mirrors none of them (migration 0168 dropped the columns and the env knobs). |
| Model aliases served | `platform_ai_config` chat/embedding models | Compared against the proxy's live list by the console's probe. |
| Per-business model override | `ai_business_gateway.model_override` | Only while the platform publishes a choice. |
| Platform revenue | `ai_wallet_settlements` aggregation | «درآمد هوش مصنوعی پلتفرم» card on `/platform/ai`. |

## Console surfaces (post-cutover)

- **`/platform/ai`** — LiteLLM connection settings (base URL, master key,
  models, fallback chain, costing rate/margin, per-turn ceiling), the revenue
  card, per-business key management (sync / refresh spend / revoke /
  model-override) and the per-business usage table (requests, tokens, charged
  Rial including allowance-used, wallet balance and remaining monthly
  allowance). The routing/budget/duration/TPM/RPM controls are **gone**.
- **`/platform/plans`** — the Plan Builder carries «اعتبار ماهانهٔ هوش مصنوعی
  (تومان)» for new plans and a per-plan «سقف هوش مصنوعی این پلن» editor; the
  plan chips badge `✦ N ت اعتبار AI`.

## Error vocabulary (user-facing)

| Code | Message |
|---|---|
| `ai_credit_required` | اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید. |
| `ai_rate_limited` | سرویس هوش مصنوعی در حال حاضر پرکاربرد است؛ کمی بعد دوباره تلاش کنید. |
| `ai_unavailable` | سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است. |
| `feature_disabled` | دستیار هوشمند برای این کسب‌وکار فعال نیست. |

The client (`errorMessage` in `use-ai-chat.ts`) prefers the server's own
message when one arrived and falls back to this table.

## The smoke suite

`integration/ai-billing-flow.integration.test.ts` walks the seven flows
end-to-end on a real Postgres:

1. allowance-first — a plan-covered turn writes no wallet debit;
2. mixed — the allowance absorbs part, the wallet pays the rest;
3. no-credit gate — no wallet and no allowance blocks the turn; an
   allowance-covered turn on an empty wallet is admitted;
4. recharge — a top-up unblocks the gate and pays down AI debt;
5. duplicate settlement — the same request id settles exactly once;
6. provider failure — the turn never settles, the wallet is untouched;
7. partial settlement — the shortfall is booked as debt that blocks the next
   turn until a recharge clears it.
