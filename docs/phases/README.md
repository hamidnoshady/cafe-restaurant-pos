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
| 18 | Phase-18-AI-Platform-Administration-Credit-Billing.md | Planned |

Phases 0–11 built a single-business POS. Phases 12–17 turn it into a multi-business platform:
many businesses isolated in one deployment, teams with real permissions, several branches per
business, a super-user console, an accounting suite, and — as of Phase 17 — entitlements,
rate limits, and a continuously-proven tenant boundary that make it safe to run for paying
strangers. Phase 12 is the load-bearing one — everything after it depends on the tenancy
boundary being right. Phase 18 turns the AI assistant (built earlier, without its own phase
doc) from a per-business bring-your-own-key toggle into a platform-run, metered service:
one operator-owned provider connection, and per-business credits/subscriptions billed against
a priced catalogue.

For overall architecture, full schema, and product summary, see the master spec doc (POS-Spec.md).
