# Cafe/Restaurant POS — Phase Index

Each phase is a self-contained file with its own scope, exit criteria, and open questions. Work through them in order; don't start a phase until the previous one meets its exit criteria.

| Phase | File | Status |
|---|---|---|
| 0 | Phase-0-Foundation.md | Implemented |
| 1 | Phase-1-Setup-Wizard.md | Implemented |
| 2 | Phase-2-Menu-Cashier-Order-Flow.md | Implemented |
| 3 | Phase-3-Table-Management-Reservations.md | Implemented |
| 4 | Phase-4-Waiter-Kitchen-RealTime-Sync.md | Implemented |
| 5 | Phase-5-Offline-Queue-Hardware.md | Implemented |
| 6 | Phase-6-Inventory.md | Implemented |
| 7 | Phase-7-Double-Entry-Ledger.md | Implemented |
| 8 | Phase-8-Reporting-Analytics-Engine.md | Implemented |
| 9 | Phase-9-Multi-Location-Rollup-Polish.md | Implemented |
| 10 | Phase-10-Backup-System.md | Implemented |
| 11 | Phase-11-Delivery-Post-V1.md | Implemented |
| 12 | Phase-12-Multi-Business-Tenancy.md | Implemented |
| 13 | Phase-13-Teams-Permissions.md | Implemented |
| 14 | Phase-14-Multi-Location-Per-Business.md | Implemented |
| 15 | Phase-15-Super-Admin-Console.md | Implemented |
| 16 | Phase-16-Accounting-Suite.md | Implemented |
| 17 | Phase-17-Feature-Gating-Hardening.md | Implemented |
| 18 | Phase-18-AI-Platform-Administration-Credit-Billing.md | Implemented |
| 18b | Phase-18b-AI-Agent-Capability-Expansion.md | Complete for the documented existing-model scope (all five waves shipped; schema-dependent follow-ups deferred) |
| 19 | Phase-19-Public-API-Webhooks.md | In progress — Wave 2 core data API |
| 20 | Phase-20-Employee-Secure-Identity.md | Complete — all eight waves shipped |
| 21 | Phase-21-Multi-Industry-Accounting-Platform.md | Complete — all seven waves shipped. Jewelry (weight/purity, gold pricing, stones, consignment), watch (serialized units, warranty, repair tickets) and accessories (variant stock and pricing) each have their own item model, posting rules, chart of accounts, setup-wizard path and dashboard, all sharing Wave 1's domain-event posting engine; Wave 7 adds weight reconciliation, consignor statements and payouts, warranty/repair reporting, variant sales analysis and a per-item audit trail. Remaining open items are product decisions, not unfinished builds: an external gold-price feed, weight-based FIFO costing for bulk gold, and coin (per-unit) pricing |
| 22 | Phase-22-Accounting-Standards-Compliance-Gap-Analysis.md | Waves 1-5 and 7 complete (Wave 4 first slice; Wave 6 is Phase 21's own remaining waves, tracked there) — audit/gap-analysis, account hierarchy levels/nature/contra metadata, a terminology standards audit, revenue split by sales channel + a platform-commission expense account, a per-account دفتر معین/گردش حساب statement, a fixed-asset register with straight-line depreciation, and a full regression pass, against GitHub issue #160. Remaining scope (tip capture, food-cost variance report, an online-platform concept) needs product decisions before further work |
| 23 | Phase-23-Subdomain-Tenancy.md | Waves 1-5 complete — typable checksummed sync tokens, a `central`/`site` deployment role with a derived sync URL, and per-business subdomains, now cut over: `ROOT_DOMAIN` (which may itself be a subdomain, e.g. `biz1.ac.eshobe.com`) is the switch, the `/{slug}/dashboard` path scheme is deleted, and each business's subdomain is typed in English by a super-admin. Still needs a DNS-01 wildcard certificate for `*.$ROOT_DOMAIN` in production. Filed as 23 because the issue's own "Phase 21" number was already taken |
| 24 | Phase-24-Security-Hardening-Data-Protection.md | Designed — all five waves specified, implementation not started, against GitHub issue #228. A threat model (three trust boundaries, seven adversaries) plus: Wave 1 perimeter and credential hardening (security response headers with a nonce CSP, login lockout for the password realms, the shared `REMOTE_SYNC_TOKEN` denied by default, per-realm JWT keys, encrypted local/USB backups, a non-root container, `/ws` revocation re-checks); Wave 2 mandatory two-factor auth for platform admins and Owners (Kavenegar SMS OTP by default, Google Authenticator TOTP as the alternative, enrolled at business creation, grace period for existing accounts); Wave 3 field-level encryption at rest with per-business keys; Wave 4 VPN-only networking and LAN HTTPS; Wave 5 the remaining hardening. Zero-knowledge end-to-end encryption is explicitly rejected — it is incompatible with server-side reporting, the posting engine and the RLS predicates |

Phases 0–11 built a single-business POS. Phases 12–17 turn it into a multi-business platform:
many businesses isolated in one deployment, teams with real permissions, several branches per
business, a super-user console, an accounting suite, and — as of Phase 17 — entitlements,
rate limits, and a continuously-proven tenant boundary that make it safe to run for paying
strangers. Phase 12 is the load-bearing one — everything after it depends on the tenancy
boundary being right. Phase 18 turns the AI assistant (built earlier, without its own phase
doc) from a per-business bring-your-own-key toggle into a platform-run, metered service:
one operator-owned provider connection, and per-business credits/subscriptions billed against
a priced catalogue. Phase 18b is the other half: growing what the assistant can actually read
and do — more tools and confirm-gated actions across every module, plus role-scoped variants —
shipped in waves after Phase 18's metering exists to bill them. Phase 19 opens the platform to
external, third-party integrations for the first time — scoped API keys and outbound webhooks
so a business can build (or commission) a "sub app" against its own data. Phase 18 and
18b are now complete, so Phase 19 starts with its independently reviewable API-key and
tenancy foundation before exposing any external data routes. Phase 21 is a different kind of
expansion from everything before it: rather than adding a capability to the existing café/
restaurant business, it turns the platform multi-industry — gold/jewelry, watch, and
accessories retail alongside the existing F&B shape, sharing one Core Accounting layer via a
new domain-event posting engine and a generalized item/variant/serial model — complete as of its
seventh wave, with all four industries selectable at signup. Phase 23 goes back to
the tenancy boundary Phase 12 established and gives it the one thing it lacked: a browser origin
per business. Until it, every tenant on a deployment shared one origin — and therefore one cookie
jar, one localStorage, one service worker — with only an app-applied path prefix between them.
Phase 24 is the first phase to treat security as its own subject rather than as a section inside
another phase's work. Phases 12 and 23 built the two boundaries that matter — the tenant row
boundary in Postgres and the browser origin boundary — and Phase 24 deliberately leaves both
alone, addressing instead everything around them that was never built: response headers, lockout
on the password realms, a second factor on every full-privilege account, encryption of data at
rest and of local backups, and a network posture where a café's box need not be reachable from
the internet at all. It also records, as a decision rather than an omission, why zero-knowledge
end-to-end encryption is not available to a product whose server has to produce a trial balance.

For overall architecture, full schema, and product summary, see the master spec doc (POS-Spec.md).
