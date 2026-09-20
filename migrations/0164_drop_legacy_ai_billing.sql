-- Phase J (migration map row M10) — drop the legacy AI-billing schema.
--
-- Phase 18 billed AI against a credit system of its own: a per-business balance
-- (`ai_business_billing`), a signed credit ledger (`ai_credit_ledger`), sellable
-- credit packages (`ai_credit_packages`), platform subscription plans
-- (`ai_subscription_plans`) and manual top-up requests (`ai_top_up_requests`),
-- all created in 0039_ai_platform_billing.sql.
--
-- Phase B (the wallet cutover, migration 0153) replaced all of it: AI spend now
-- debits the canonical `business_wallets` from LiteLLM's real reported cost,
-- with the wallet's row-locking and no-negative-balance guarantees, and no
-- second AI-only balance. 0153 was deliberately ADDITIVE — it left these tables
-- in place, readable, so an operator could reconcile the cutover in production
-- before anything was destroyed. The migration map named that reconciliation
-- (row M10, "drop ai_business_billing/ai_credit_ledger AFTER wallet cutover
-- proven") as the gate on this step.
--
-- With the wallet cutover confirmed, this migration retires the legacy schema.
-- It is the destructive half of Phase J; the dead service code
-- (`ai-billing-service.ts`) and the Phase 18 renewal tick were removed in the
-- same change.
--
-- Safety notes:
--   * These five tables have no inbound foreign keys from any surviving table —
--     the only foreign keys among them point at each other
--     (ai_business_billing → ai_subscription_plans, ai_top_up_requests →
--     ai_credit_packages, ai_top_up_requests → ai_credit_ledger). Dropping all
--     five together with CASCADE resolves those intra-group references without
--     touching anything outside the group.
--   * No view depends on them.
--   * `DROP TABLE IF EXISTS` keeps this idempotent and safe on any database
--     where an earlier manual cleanup already removed one of them.
--   * Never dropped in the same migration that introduced its replacement:
--     the wallet arrived in 0153, eleven migrations earlier.

DROP TABLE IF EXISTS ai_top_up_requests CASCADE;
DROP TABLE IF EXISTS ai_credit_ledger CASCADE;
DROP TABLE IF EXISTS ai_credit_packages CASCADE;
DROP TABLE IF EXISTS ai_business_billing CASCADE;
DROP TABLE IF EXISTS ai_subscription_plans CASCADE;
