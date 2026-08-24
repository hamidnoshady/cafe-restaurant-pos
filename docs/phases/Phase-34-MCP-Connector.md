# Phase 34 — the MCP connector

## Why

Every AI surface this app has built so far points inward. The assistant, the
proactive digests, autopilot and the coworker all run a model *we* call, with
*our* prompt, paid for out of *our* credit balance, inside this codebase. That is
the right shape for an owner who wants the app to be smart. It is the wrong shape
for the owner who already pays for Claude or ChatGPT, has it open on their phone
all day, and simply wants to ask *it* how last week went.

Phase 19's public API does not help. A chat client cannot read an OpenAPI
document, cannot mint itself a key, and has no idea that «۱۲۰۰۰۰۰» is Rial. What
those clients can do — all of them, by pasting a single URL — is add a **remote
MCP server**. So this phase is one HTTP endpoint that describes its own tools, and
the OAuth 2.1 authorization server that makes "paste a URL and press connect" the
whole of the setup.

Three things had to be true or it was not worth building:

1. **It works from the phone.** Claude's mobile and desktop connector UI, and
   ChatGPT's, offer exactly one field: a URL. There is nowhere to paste an API
   key. That forces a real authorization server — discovery documents, dynamic
   client registration, PKCE, refresh tokens — not a shortcut.
2. **Read and write are separate grants, and write trust is a separate question
   again.** "Let Claude read my sales" and "let Claude change my prices" must not
   be one checkbox, and the second must not silently mean "without asking me".
3. **It opens no new mutation path.** Whatever a model does through this, it does
   through the same service function the dashboard calls.

## What was built

### The endpoint

`POST /api/mcp` — JSON-RPC 2.0 over the Streamable HTTP transport. One message
(or a batch) in, one JSON response out.

There is deliberately **no SSE stream and no session id**. Every method here is
request/response and nothing is ever pushed, so a stream would be a resource to
keep alive, resume and expire in exchange for behaviour nobody could observe.
`GET /api/mcp` answers 405, which is the documented way to say a server offers
no stream, and `capabilities.listChanged` is false everywhere rather than
promising notifications that cannot arrive.

Implemented: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`, `resources/templates/list`, `prompts/list`, `logging/setLevel`.
The last three answer with an empty result rather than "method not found" — a
client that gets an error for `resources/templates/list` stops asking about
resources altogether.

### The 401 is the feature

An unauthenticated call answers `401` with

```
WWW-Authenticate: Bearer resource_metadata="https://{host}/.well-known/oauth-protected-resource", scope="pos.read pos.write"
```

That header is the entire discovery chain. A client that has never seen this
business reads it, fetches the RFC 9728 document it names, finds the
authorization server, registers itself under RFC 7591, and starts the flow —
with nobody typing anything but the original URL. Dropping that header breaks no
test; it breaks discovery, silently, in a client that shows no error.

Both discovery documents are served twice, at the bare `/.well-known/…` path and
at the RFC 9728 path-inserted form (`/.well-known/oauth-protected-resource/api/mcp`),
because clients differ on which they try and a 404 on either reads as "this
server does not support OAuth". They live under `/api/well-known/*` and are
rewritten into place in `next.config.ts`, since Next's app router will not serve
a dot-prefixed route folder.

### The OAuth server

| Endpoint | What it does |
| --- | --- |
| `POST /api/mcp/oauth/register` | RFC 7591 dynamic client registration. Public clients only — no secret is issued, because every client that reaches this server is a phone, desktop or browser app that cannot keep one. |
| `GET /api/mcp/oauth/authorize` | Validates, then hands the browser to the consent page. Authorizes nothing itself. |
| `POST /api/connections/mcp/consent` | **The only step that decides anything**, and the only one behind a session. Owner-only. |
| `POST /api/mcp/oauth/token` | `authorization_code` and `refresh_token`. Makes no policy decisions — they were all recorded on the code. |
| `POST /api/mcp/oauth/revoke` | RFC 7009. Always answers 200. |

Five properties are load-bearing, each written down where it is enforced:

- **PKCE is S256 or nothing.** `plain` is refused outright, so there is no
  downgrade to request, and the verifier comparison is constant-time.
- **`client_id` and `redirect_uri` are validated before anything else.** Only
  once both are known-registered does any other failure become a redirect. The
  other order makes `/authorize` an open redirect: hand it an arbitrary
  `redirect_uri` plus a deliberately broken `response_type` and it bounces a
  victim wherever you like.
- **Redirect URIs match exactly**, with one concession: RFC 8252 §7.3's loopback
  port, because a desktop client binds an ephemeral one it cannot know at
  registration time. No prefix matching, no "same host".
- **A code is claimed with a conditional `UPDATE`**, so single use is enforced by
  the database rather than by a read-then-write, and a failed PKCE check leaves
  it spent — a code redeemed with the wrong verifier has probably leaked.
- **Refresh rotates, and re-reads the connection's current scopes.** An owner who
  narrowed a connection has narrowed it for real: the next refresh cannot restore
  what they took away, and the old refresh token is dead the moment it is used,
  which is the only thing that makes a stolen one detectable.

The consent page (`/mcp/consent`) sits outside `/dashboard` on purpose: this is
an authorization ceremony, not a settings screen. The owner arrives from another
app mid-flow, makes one decision, and leaves. Middleware carries the full URL
through `?next=` so an owner who was signed out lands back on the exact request
after logging in — which is why the login form gained `?next=` support in this
phase.

### Two grants, two write modes

`pos.read` and `pos.write` are independent, so an owner can grant read-only,
write-only, or both. Read-only is what the consent screen and the token form
both preselect.

Given `pos.write`, a connection is additionally in one of two modes:

- **`approve`** (the default) — the model's write becomes a pending row and
  changes nothing. It appears in the owner's list under «اتصال‌ها ← دستیارهای هوش
  مصنوعی» and applies only when a human presses تأیید, at which point the
  **stored payload** runs unchanged: the connector gets no second say, so the
  figure the owner read is the figure that is written.
- **`apply`** — the write happens now. The owner pressed "trust this connector"
  once instead of pressing Apply every time.

Both are per connection, chosen by the owner, and changeable afterwards from the
connections screen without re-running OAuth on a phone.

### The tools

The **read** half is not a second list to keep in step with the assistant's. It
*is* `toolDefinitions("dashboard")`, executed by `runReadTool` — the same code
reading the same views. A question asked through Claude and the same question
asked in «دستیار» must not be able to disagree about last week's revenue, since
only one of them is in the room to be corrected. Adding a read tool to `ai.ts`
adds it to MCP for free.

Two are excluded: `propose_action` (the in-app confirm gate — over MCP a write is
a tool the client calls directly) and `draft_expense_from_receipt` (it reads an
image attached to the current chat turn, and there is no such attachment here).

What is added on top is **one English sentence in front of each Persian
description** — never instead of it, because the Persian text carries the domain
rules. The in-app assistant is prompted in Persian for a Persian owner; an MCP
client may be driving a model reasoning in English about that same business, and
a tool it cannot read is a tool it will not call.

The **write** half is exactly the `ACTION_CATALOG` entries that have a
server-side executor and are not `coworkerOnly` — nine tools —
and `assertWriteToolsMatchCatalogue()` fails the unit test if that drifts:

`write_menu_item_price`, `write_menu_item_availability`, `write_order_discount`,
`write_purchase_draft`, `write_stock_count`, `write_customer_note`,
`write_journal_draft`, `write_expense`, `write_production_run`.

Each runs the same Phase 31 executor a coworker job runs, which calls the same
service function the route handler calls. There is no MCP-specific write anywhere
in this codebase.

**`inventory.waste.log` is absent, and must stay absent.** Phase 31 kept waste out
of autopilot because "why did this stock leave" is a fact only a person in the
room has; Phase 32 let a coworker *job* log it because the owner supplied that
fact in advance, when they wrote the job. A model in a chat window has supplied
nothing, so it is back to the Phase 31 position.

Actions with no executor are absent too — the setup-wizard six, the live floor
five (reservations, tables, courier) and `menu.item.create`. That is not an
omission to fix by writing an executor: each was left without one deliberately.

### Resources — so a model knows what it is looking at

Three, and no more, because most clients read the whole list on every
conversation:

- `pos://app/overview` — `describe_app`: the trade, the branches, the modules,
  the vocabulary.
- `pos://app/conventions` — how this system stores money, dates, quantities and
  the business day, and the mistakes a model makes assuming otherwise.
- `pos://reports/catalog` — every standard report key.

Without them a model connecting to a Persian jewellery shop's POS will talk about
«سفارش» where the trade says «فاکتور», divide Rial the wrong way, and bucket a
night shift's sales at midnight. Each of those is a confident, plausible, wrong
answer about money — the failure `ai-labels.ts` exists to prevent inside the app,
applied to a model running outside it.

### Everything else

- **Auth is a fourth realm** alongside tenant sessions, platform sessions and
  API keys — `withMcpScope` in `src/lib/mcp/auth.ts`, the same shape as
  `withApiKeyScope`. Both credential kinds (a pasted `posmcp_…` token and an
  OAuth `posmcp_at_…` access token) resolve to one `mcp_connections` row, are
  looked up fresh on every call, and cache nothing — so a revoke bites on the
  connector's very next request.
- **Gated on `api_platform`**, the same entitlement as the public API: both are
  "this business's data, reachable by a program it chose".
- **A write is never anonymous.** It runs under the owner who authorized the
  connection; a connection whose authorizer has been deleted can still read but
  every write is refused, the rule `ai_autopilot_settings.authorized_by` and
  `ai_coworker_jobs.authorized_by` already encode.
- **Every write lands in `ai_action_audit`** with `source = 'mcp'` and a new
  `mcp_connection_id`, so the hub's history shows all four ways a change can have
  been authorised in one list, with the same `prior_state` and the same undo.
- **Its own rate-limit bucket** in middleware, keyed by bearer credential (or by
  IP during the OAuth flow), at 240/minute — higher than the public API's,
  because one model turn routinely fans out into several tool calls.
- **Reads are not audited.** An assistant asking twenty questions is not twenty
  events; `mcp_connections.last_used_at` answers "is this connector live".

## Decisions

**Q: Should an MCP write go through Phase 31's autopilot caps?**
No. Autopilot's caps govern *unattended, self-directed* writes by a background
tick. An MCP write is attended — a human is in a chat asking for it — which makes
it the shape of a chat "Apply", not of a tick. The connection's own write mode is
the gate instead, and `approve` is the default. What Phase 31 *does* still decide
is the catalogue: `coworkerOnly` keeps waste out.

**Q: Where do approvals live — the coworker inbox at `/dashboard/ai`?**
No. That inbox is job/run-shaped (`ai_coworker_runs` requires a `job_id`), and an
MCP write has no job. The pending list lives in the MCP tab of the connections
hub, on the same page as the connector that asked for it, so revoking and
rejecting are one click apart.

**Q: Bind OAuth client registrations to a business, or keep them global?**
Per business. Each business is served from its own origin (Phase 23), so the host
a client registered at *is* the tenant — which means every table in this phase is
tenant-scoped with the standard RLS policy, and no new `withoutTenantScope` hole
was needed for the OAuth flow. The one bypass added, `mcp-token-auth`, is for
resolving a bearer credential and is identical in shape to `api-key-auth`.

**Q: Reconstruct the consent redirect's absolute URL, or emit a relative one?**
Relative. `request.url` inside a route handler is the *container's* origin, so
redirecting there sends the browser to a port nothing is listening on — the trap
`/api/host/redirect` already documents, and one this phase hit in testing.
Rebuilding it from `x-forwarded-host` would let a client-supplied header decide
where an authorization request goes. A relative `Location` is resolved by the
browser against the URL it actually asked for.

## Exit criteria

| Criterion | Where it is satisfied |
| --- | --- |
| A connector can be added from Claude/ChatGPT by pasting one URL | `WWW-Authenticate` challenge → `/.well-known/*` (rewritten in `next.config.ts`) → `/api/mcp/oauth/register` → `/authorize` → `/mcp/consent` → `/token`; walked end to end in `integration/mcp-connector.integration.test.ts` › "goes register → consent → code → token → a working read connection" |
| Read and write are separately grantable | `src/lib/mcp/scopes.ts` + `scopes.test.ts`; consent screen and token form both default to read-only |
| A read-only connection cannot write | `mcpToolCatalogue` filters by scope and `tools/call` re-checks — integration test "hands a read-only connection no write tools at all" and "refuses a write tool a read-only connection asks for by name anyway" |
| Write mode is the owner's choice, per connection | `mcp_connections.write_mode`; integration tests under "writing in apply mode" / "writing in approve mode" |
| An approval-mode write changes nothing until a human says yes | integration test "changes nothing, and says so instead of claiming success" |
| No new mutation path | `src/lib/mcp/write-service.ts` calls `AUTOPILOT_EXECUTORS` only; `tools.test.ts` › "binds each tool to the executor its catalogue entry names, not to a new path" |
| Waste stays out of a model's reach | `tools.test.ts` › "never exposes waste logging" |
| Revocation is immediate | `authenticateMcp` re-reads on every call; integration test "stops working on the very next call after a revoke" |
| Tenant isolation holds | `integration/tenant-isolation.integration.test.ts` (all four tables) + "never lets one business's connector reach another's data" |
| PKCE, redirect matching and code single-use are correct | `src/lib/mcp/oauth.test.ts` (23 tests) + the OAuth section of the integration test |
| Works with a header-only client (Codex, IDEs, scripts) | static `posmcp_…` tokens, minted from the connections panel; sample config in the panel's own help card |

## Deliberately not in scope

- **Creating or settling orders over MCP.** That mutation path is driven only by
  the POS screen today, and a second one is how a divergent sale path starts.
- **An SSE / streaming transport.** Nothing is ever pushed; see above.
- **Prompt templates (`prompts/list` returns empty).** `initialize`'s
  `instructions` carry what a prompt would, and are paid for once per session
  rather than listed and fetched.
- **Reading the app's *screens*.** A model gets the data and the vocabulary, not
  a description of the UI — the UI is what the owner is looking at.
