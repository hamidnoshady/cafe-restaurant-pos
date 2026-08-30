# Phase 38b — LiteLLM Platform (costing, usage, prompts & skills, MCP)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 37 (the LiteLLM gateway as a provider: virtual keys, budgets, aliases,
failover), Phase 18 (the Rial credit ledger every call is still billed against), Phase 34 (the
MCP connector the proxy can now front), Phase 36 (RAG/embeddings) and the prompt manager
(0112/0115).
**Goal:** Make LiteLLM the platform's single AI management plane — its **API management**
(virtual keys, budgets, rate limits), its **costing** (the gateway's own cost figures replace
manual estimation), its **usage** (the proxy's spend logs become the app's usage analytics), its
**prompt management & skills** (gateway-held prompt templates bound per agent surface) and its
**agentic/MCP** layer (the proxy fronts MCP servers, including this application's own, and
executes their tools inside a turn). The Rial ledger stays the only thing a business is billed
against; what changes is where the *cost side* of that ledger comes from.

---

## Context: what Phase 37 left on the table

Phase 37 deliberately kept money out of the gateway: spend figures were diagnostics, the cost
behind every Rial charge came from two manually-configured per-million token rates, and when a
provider omitted a usage block the turn was billed on `estimateTokens` — a deliberate
over-count of Persian text. That was the right call for introducing the gateway, and it is now
the gap: the platform pays its vendors in a currency LiteLLM prices automatically, the console
could show only a cumulative per-key spend with no days, no models and no request counts, the
prompt manager's platform layer could only be edited in this application (and deployed through
this database), and an MCP server could not reach the assistant at all.

LiteLLM already does all four jobs — it prices every completion from its model-cost map and
reports the figure on every response (`x-litellm-response-cost`, USD); it accumulates one spend
log per request (`/spend/logs`, with the calling key's alias, model, tokens and cost); it
serves prompt templates (`prompts:` in its config — dotprompt files or any supported
integration) that a completion can reference with `prompt_id` + `prompt_variables`; and it
fronts MCP servers and can auto-execute their tools inside `/v1/chat/completions` when the
request declares `tools: [{type: "mcp", server_url: "litellm_proxy/<name>/mcp", …}]` with
`require_approval: "never"`.

The load-bearing decision of this phase is the same one Phase 37 made: **the gateway is a
capability of the one provider connection, not a second connection.** Every new feature below
is inert unless the deployment actually runs `provider = litellm` (or has the gateway
configured), and a deployment that never touches it is byte-for-byte today's behaviour.

## Decisions

- **Costing moves, pricing policy stays.** With `gateway_costing_enabled`, a turn's real cost
  is the gateway's reported USD figure × `usd_rial_rate` (both stored on the gateway row), and
  the charge is that cost with the platform's existing `revenue_margin_percent` on top — the
  same cost-plus-margin policy Phase 18 chose, now applied to a measured cost instead of two
  hand-set rates. The manual token rates remain the fallback whenever the gateway did not
  report a cost (a turn answered from the semantic answer cache has no completion to price;
  a direct-vendor deployment never will), and remain authoritative while the switch is off.
  A gateway-reported cost is never allowed to make a turn cheaper than the token-rate floor
  for it — the two are computed and the **higher** is charged, so a mispriced model on the
  gateway can never silently under-charge. Wait — no: it can, and that is the point of
  trusting the gateway. The higher-figure rule would silently re-introduce the manual rates as
  the real source. The rule that IS implemented: gateway cost when reported, token rates when
  not, never zero.
- **Money stays integer Rial.** `usd_rial_rate` converts once, the product is rounded up to a
  whole Rial, the margin is applied to the converted figure, and no USD value ever reaches a
  balance or a client payload. The gateway's USD spend remains a reconciliation diagnostic.
- **Usage is a synced rollup, not a live proxy query.** `ai_gateway_usage` stores the app-side
  daily rollup (day × key alias × model) of the proxy's spend logs, refreshed by an explicit
  operator action (and safe to call repeatedly). Days are UTC days — the gateway has no
  knowledge of a branch's trading-day offset, and pretending otherwise would misstate which
  day a request belongs to. The key alias → business mapping is resolved at sync time from
  `ai_business_gateway`; logs under the master key or an unknown alias keep their alias but
  resolve to no business, and still count.
- **Prompts are bound per surface, and the dynamic context travels as a variable.** A bound
  surface stops sending the code-built system message and instead sends
  `prompt_id: <bound>` with `prompt_variables: {system_context, business_name, user_name,
  mode}` — the template in the gateway is authored to include `{{system_context}}`, which is
  the full text `buildSystemPrompt` would have sent. The confirm-before-write rules therefore
  keep travelling on every bound turn even though the prose now lives gateway-side; a template
  that drops the variable drops the guardrails, which is why the console names the variable in
  its help text. Business prompt overrides (0115) keep appending after it, unchanged.
- **Skills are surfaces.** The product already names its agent surfaces (wizard, dashboard,
  floor, proactive, autopilot, platform) as the unit a prompt is authored for; a "skill" in
  the gateway console is that same unit bound to a gateway prompt template. No new taxonomy.
- **MCP servers are explicit, and approval is always "never" for the proxy only.** The app
  declares each server (name, label, URL); the proxy turns them into OpenAI function tools and
  auto-executes them mid-turn. This is delegated read/write agency *by configuration*, so the
  console's section is owner-only and the list is empty by default. This application's own
  `/api/mcp` connector (Phase 34) can be listed like any other server, which makes LiteLLM the
  single MCP hub for both directions — external clients dial the app's connector, and the
  assistant reaches third-party tools through the proxy.
- **`require_approval: "never"` is the only supported value** because the app's own agent
  loop cannot answer an approval round-trip the proxy opens mid-stream; a server the platform
  does not trust should not be in the list at all.

## Scope

- **Migration 0123**: `usd_rial_rate`, `gateway_costing_enabled`, `prompt_bindings`,
  `mcp_enabled`, `mcp_servers` on `platform_ai_gateway`; the new RLS-scoped
  `ai_gateway_usage` rollup table.
- **Per-request cost capture** in `ai-service.ts`: the `x-litellm-response-cost` header is
  read on every provider call (streamed and not), summed across the agent loop's tool rounds,
  and returned as `costUsd` beside the token usage.
- **Gateway-cost settlement**: `settleAiTurn` accepts a gateway-computed price; the chat,
  receipt-extraction, invoice-OCR and autopilot surfaces pass one when the platform runs
  gateway costing and the turn reported a cost. Ledger metadata records the USD figure and
  the converted cost beside the usual Rial numbers.
- **Usage sync + console**: `/spend/logs` → `aggregateSpendLogs` (pure) → upsert
  `ai_gateway_usage`; `POST /api/platform/ai/gateway/usage` refreshes, `GET` reads; the
  console gains a usage table (per day/alias/model, USD and converted Rial). The business's
  own gateway endpoint returns its own usage rows — RLS does the scoping.
- **Prompt bindings**: config + validation + the runtime body (`prompt_id`,
  `prompt_variables`) and dropping the system message for bound surfaces; console inputs per
  surface.
- **MCP servers**: config + validation + the `tools` array in the request body; console
  editor (one server per line: `name | label | url`).
- **Proxy config**: `docker/litellm/config.yaml` documents the `prompts:` (dotprompt GitOps)
  and `mcp_servers:` blocks this phase assumes, plus the env vars the app's own connector
  needs.
- **Tests**: the pure layer (pricing, header parsing, body builders, log parsing, rollup
  aggregation, normalisation/validation) in `ai-gateway.test.ts`; request-shape tests
  (prompt-bound turns omit the system message and send the variable; MCP servers become
  `tools`) in `ai-service.test.ts`; the new table is covered by the Phase 17 generated
  tenant-isolation test like every tenant-scoped table.

## Out of scope

- **Replacing the Rial ledger with LiteLLM budgets.** Unchanged from Phase 37: budgets are a
  USD backstop enforced outside the application; `spend_usd` stays a diagnostic.
- **LiteLLM's enterprise spend-report endpoints.** `/global/spend/report` is enterprise
  licensed; the integration reads `/spend/logs`, which the open-source proxy serves.
- **Streaming through `/v1/responses` or swapping the agent loop for the proxy's.** The app's
  agent loop (Persian, human-confirmed writes, per-tenant RLS-scoped tools) is the product;
  the proxy's MCP auto-execution is an *addition* inside the existing loop, not a replacement
  of it.
- **Per-request usage rows.** The app stores the daily rollup, not one row per request; the
  proxy keeps the request-level audit trail.
- **Embedding-cost capture.** `/embeddings` responses carry the header too, but embedding
  turns are settled on tokens today; adopting them is a follow-up, not part of the move.

## Exit criteria

- With gateway costing off (the default), every settlement is byte-identical to Phase 37's:
  same function, same rates, same rounding.
- With gateway costing on and a cost reported: the charge is `ceil(usd × rate) × margin`,
  recorded with its USD source; with no cost reported: the token-rate path, never zero.
- `ai_gateway_usage` passes the generated tenant-isolation test; a business can read its own
  rows and no others.
- A bound surface's request carries `prompt_id` + `prompt_variables` and **no** system
  message; an unbound surface's request is byte-identical to Phase 37's.
- MCP servers appear in the request body exactly as configured and never for a
  non-gateway deployment.
- The usage console shows per-day totals that reconcile with the proxy's own Usage tab for
  the same window, and a failed sync changes nothing already stored.
- No master key, virtual key or MCP server credential is ever rendered in a response.
