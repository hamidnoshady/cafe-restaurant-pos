# Phase 37 — LLM Gateway (LiteLLM)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 18 (AI Platform Administration & Credit Billing — every call this phase
routes is still metered by it), Phase 18b (the tool/action catalogue those calls use), Phase 31
(Autopilot) and Phase 32 (Coworker) for the unattended surfaces, and Phase 36 Wave 6/7 (RAG and
the semantic answer cache) for the embedding path this phase finally separates from chat.
**Goal:** Put one OpenAI-compatible gateway in front of every upstream model vendor, so the
platform gets failover between providers, per-business spend attribution and budgets inside the
gateway, model aliases that can be changed without a redeploy, and real usage numbers instead of
an estimate — without disturbing the Rial credit ledger that a business is actually billed
against.

---

## Context: what exists today

Phase 18 made the assistant a platform-run, metered service, and it did that with one connection:
`platform_ai_config` holds a provider (`openrouter` or `arvan`), a model, a base URL and one API
key, and every business's assistant call uses them. `src/lib/ai-service.ts` is a single
provider-agnostic OpenAI client, because both vendors speak `/chat/completions`. That design is
right for a shop buying from one vendor and wrong for a platform serving many:

- **One vendor outage is a platform-wide outage.** There is no retry, no fallback, and no second
  deployment to fail over to. The assistant, the proactive digests, autopilot, the coworker and
  receipt extraction all stop at once, for every tenant.
- **Embeddings are all-or-nothing.** `src/lib/ai-embeddings.ts` documents the consequence:
  OpenRouter routes chat models and not embedding models, so on that provider RAG and the answer
  cache silently degrade to "off". A single connection cannot send chat to one vendor and
  embeddings to another.
- **Usage is sometimes estimated.** When the provider omits a usage block, `ai-billing.ts` falls
  back to `estimateTokens` — `chars / 2`, deliberately over-counting Persian/UTF-8 text — and the
  business is billed on that number.
- **There is no per-business identity at the provider.** Every tenant's spend lands on one vendor
  key. The only thing separating them is this application's own Rial ledger, which is accurate but
  is also the only ceiling: nothing outside the app stops a runaway tenant.
- **Changing model means changing config.** A model id is a literal string in a singleton row;
  there is no indirection through which "the cheap model" could be repointed.

A gateway (LiteLLM) sits in front of many upstreams and speaks the same OpenAI protocol. So the
load-bearing decision of this phase is that **the gateway is not a second connection — it is a
third value of the existing `provider` column.** `litellm` joins `openrouter` and `arvan` in
`src/lib/ai.ts`'s `PROVIDERS`, and every call site keeps doing what it does today.

## Scope

- **A `litellm` provider**, selectable in `/platform/ai` like any other. Base URL defaults to
  `http://litellm:4000/v1`; the key falls back to `LITELLM_MASTER_KEY`.
- **A gateway settings singleton** (`platform_ai_gateway`, migration 0117): address, admin
  credential, chat and embedding model aliases, a failover chain, routing strategy, virtual-key
  defaults, and whether a business may choose its own model — plus the published list it may
  choose from.
- **A per-business gateway row** (`ai_business_gateway`, same migration): the virtual key this
  business's calls authenticate with, its budget/rate ceilings, and its model choice. Tenant
  scoped, RLS forced, covered by the Phase 17 generated isolation test without being hand-added
  to any list.
- **Per-call resolution** in `src/lib/ai-runtime.ts`, applied in one place: which credential to
  send, which model to ask for, whether to attach the failover chain. Every AI surface calls it
  instead of `getPlatformAiConfig()`.
- **A console page, `/platform/ai/gateway`**: connection settings, a "test connection" button that
  reports latency and lists the gateway's models, and per-business key provisioning, revocation,
  spend refresh and model override.
- **A business-facing panel** on `/dashboard/ai/settings`: the model in force for this business,
  and a picker limited to the models the platform published — only when the platform switched that
  on.

## Out of scope

- **Replacing the Rial ledger.** Gateway budgets are USD and are a *backstop enforced outside the
  application*. The number a business is billed and shown remains the integer-Rial balance in
  `ai_business_billing`; `spend_usd` on the business row is a reconciliation diagnostic, never a
  billing source.
- **Billing from the gateway's own cost figures.** LiteLLM prices calls from its own model-cost
  table. Phase 18's cost-plus-margin pricing stays the single source of truth for what a turn
  costs a business.
- **Provisioning LiteLLM itself in the on-prem stack.** The compose service is behind a profile
  (`docker compose --profile ai up -d litellm`) precisely because a laptop or offline install
  must keep running with no gateway container at all.
- **Guardrails, prompt logging and LiteLLM's admin UI.** The proxy's `/logs` endpoint exposes full
  prompt text; this phase does not enable it, and the gateway is never published to the host.
- **Automatic failover *testing*.** The chain is configuration; proving it works means triggering a
  real provider error in a non-production environment.

## Exit criteria

- With no gateway configured, every request this phase touches is byte-identical to today's: no
  extra body fields, no substituted key, no rewritten model. (`buildGatewayRuntime` returns
  `undefined`, and `ai-gateway.test.ts` asserts it.)
- With the gateway enabled, a tenant call carries that business's virtual key, the resolved model
  alias, and the failover chain; embeddings can resolve to a different alias than chat.
- A failure to *read gateway state* degrades to the platform connection and logs — it never fails
  a turn that would have succeeded before the gateway existed.
- A business can be given a virtual key and have it revoked, and the gateway's reported spend for
  that key is visible in the console.
- A business may only select a model the platform published; a row written before the list was
  tightened no longer reaches a withdrawn model.
- `ai_business_gateway` passes the generated tenant-isolation test; `platform_ai_gateway` is
  exempt with a documented reason, as a deployment-wide singleton.
- No business-facing response or client payload ever contains the master key or a virtual key.

## Decisions

1. **The gateway is a provider, not a parallel subsystem.** A separate "AI backend" abstraction
   would have meant two code paths to keep in step — and the second one would have been the one
   almost nobody runs. Because every vendor here already speaks `/chat/completions`, adding
   `litellm` to `PROVIDERS` makes the gateway an ordinary configuration choice, and the gateway
   features that need per-call decisions ride on `AiConfig.gateway` as optional fields, so a
   direct vendor connection produces no gateway code path at all.

2. **Per-call decisions are resolved once, in `ai-runtime.ts`, not branched on at each call site.**
   Six surfaces call the provider. If each decided for itself whether a gateway was in play, the
   answer would drift — and the drift would show up as one business's calls being charged to
   another's key. One resolver, called by all of them, is the only shape where "which key is this"
   has a single answer.

3. **Degrade, never fail.** The gateway is an addition to a working system, so every failure mode
   in the request path falls back to the platform connection: an unreachable gateway, a missing
   row, an unparseable response. The exception is provisioning, which is an operator pressing a
   button and asking for something — there, silence would be worse than an error.

4. **A business's model choice is validated on read, not only on write.** `resolveChatModel`
   re-checks the override against `publishedModels` every call. The alternative — trusting the
   stored row — leaves a window in which a model the platform has stopped selling keeps being
   called because nobody edited the row that named it.

5. **Virtual keys are stored in the clear, and that is the same bargain Phase 18 already made.**
   `platform_ai_config.api_key` is stored the same way, because the server must be able to send
   it. What makes a virtual key a lesser secret is its scope: it is spend-limited and revocable
   per business, and the worst case is one business exhausting its own gateway budget — which the
   Rial credit ceiling has already bounded.

6. **Budgets are USD, billing is Rial, and the two are never confused.** The gateway cannot bill
   in Rial, so its budgets are a safety net with its own unit and its own column, clearly labelled
   as a diagnostic. Mixing them would mean either lying to the gateway about what it is
   denominated in, or showing a business a number in a currency the rest of the app never uses.

7. **There is exactly one address, and it belongs to the provider connection.**
   The gateway row still carries a `base_url`, but it is a fallback used only
   while the provider is *not* yet `litellm`, so the gateway's features can be
   configured before the connection is switched over. The moment the provider
   is the gateway, `platform_ai_config.base_url` **is** the gateway's address
   and wins (`resolveGatewayBaseUrl`). Two stored addresses would only ever
   drift apart, and the failure mode is nasty: chat going to one host while
   keys are minted on another, with both halves looking configured.

8. **The gateway is network-internal and profile-gated.** It holds every upstream vendor key, and
   its management API can mint keys and read every prompt that has passed through it. It is on the
   compose network only, never published, never routed through Traefik, and not started unless an
   operator asks for the `ai` profile.

## Status

Implemented. Migration `0117_ai_litellm_gateway.sql` widens the provider catalogue and adds both
tables; `src/lib/ai-gateway.ts` holds the pure resolution and parsing logic (40 unit tests in
`ai-gateway.test.ts`); `src/lib/ai-gateway-service.ts` holds the row access and the management-API
calls; `src/lib/ai-runtime.ts` is the single seam the request path goes through.

Not covered by an integration test: the calls to a live LiteLLM proxy. `ai-gateway.test.ts`
covers every parser and resolver against recorded response shapes, but no test in this repository
starts a gateway — doing so would mean either a Python service in the test path or a mock that
proves nothing about the API the proxy actually exposes.
