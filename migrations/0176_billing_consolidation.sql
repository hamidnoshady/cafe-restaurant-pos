-- ============================================================================
-- 0176_billing_consolidation.sql — ONE commercial architecture under Billing.
--
-- The audit that produced this migration found the platform's commercial
-- configuration split across five surfaces:
--
--   1. `plans` (0034)  — the limits catalogue (branch/member/order ceilings).
--   2. `billing_plans` (0130/0168) — the pricing catalogue (monthly fee,
--      per-feature prices, monthly AI credit). `saveBillingPlan` dual-wrote a
--      bare (key, name) row into `plans`, so a plan created in the Plan
--      Builder existed in BOTH catalogues but carried limits in NEITHER —
--      i.e. it silently became unlimited (the exact bug the §10 rule forbids).
--   3. Messaging credit packages + per-segment rates managed inside
--      /platform/messaging (0133).
--   4. The media daily-storage tariff managed inside /platform/media (0149).
--   5. Per-business commercial state scattered between businesses.plan (a
--      free-text-with-FK label), business_entitlements and business_features.
--
-- This migration makes `billing_plans` the ONE plan domain — limits, pricing,
-- packaging and lifecycle (draft/active/retired) on one row — retires the
-- `plans` table, and adds the missing commercial domains: a real subscription
-- lifecycle, invoices, and auditable per-business overrides.
--
-- Ownership afterwards (single source of truth per concern):
--   /platform/billing owns every writable commercial field (plans, prices,
--     limits, packages, rates, gateways, subscriptions, invoices).
--   /platform/ai, /platform/messaging, /platform/media keep technical
--     configuration only and display commercial values read-only.
--
-- Backfill precedence (deliberate, documented):
--   * limits      — `plans` is authoritative: it is the table plan-limits.ts
--                   enforced against since 0034. billing_plans rows with no
--                   `plans` counterpart were unlimited until now, so they
--                   stay NULL (= unlimited): behaviour is preserved, not
--                   silently changed. (The Billing UI now requires an
--                   explicit محدود/نامحدود choice for every new plan.)
--   * pricing     — `billing_plans` is authoritative; untouched.
--   * status      — is_active=true → 'active'; is_active=false → 'draft'
--                   (editable, unpurchasable — the safer of the two closed
--                   states; no seeded row ships inactive).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. One plan domain: status + limits + trial/grace on billing_plans.
-- ---------------------------------------------------------------------------
ALTER TABLE billing_plans
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('draft', 'active', 'retired')),
    ADD COLUMN IF NOT EXISTS branch_limit integer
        CHECK (branch_limit IS NULL OR branch_limit >= 0),
    ADD COLUMN IF NOT EXISTS member_limit integer
        CHECK (member_limit IS NULL OR member_limit >= 0),
    ADD COLUMN IF NOT EXISTS monthly_order_limit integer
        CHECK (monthly_order_limit IS NULL OR monthly_order_limit >= 0),
    ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 0
        CHECK (trial_days >= 0),
    ADD COLUMN IF NOT EXISTS grace_days integer NOT NULL DEFAULT 7
        CHECK (grace_days >= 0);

-- Limits: `plans` is the authoritative source (see header). Existing
-- billing_plans rows that a super-admin created without a `plans` row were
-- unlimited in practice and stay unlimited.
UPDATE billing_plans bp
   SET branch_limit        = p.branch_limit,
       member_limit        = p.member_limit,
       monthly_order_limit = p.monthly_order_limit
  FROM plans p
 WHERE p.key = bp.key
   AND (bp.branch_limit IS NULL AND bp.member_limit IS NULL AND bp.monthly_order_limit IS NULL);

-- A limits-catalogue row with no pricing row (possible when a deployment only
-- ever used the 0034 catalogue) must survive the table retirement: create its
-- billing_plans counterpart so no business's plan key dangles.
INSERT INTO billing_plans (key, name, branch_limit, member_limit, monthly_order_limit,
                           monthly_price_rial, status, sort_order)
SELECT p.key, p.name, p.branch_limit, p.member_limit, p.monthly_order_limit,
       NULL, 'active', 50
  FROM plans p
ON CONFLICT (key) DO NOTHING;

-- Status from the old boolean (before it becomes derived).
UPDATE billing_plans SET status = 'draft' WHERE is_active = false;

-- `is_active` becomes a derived column so no writer can ever disagree with
-- `status` again: active ⇔ status='active'. draft/retired both read inactive,
-- exactly what every existing reader of is_active meant.
ALTER TABLE billing_plans DROP COLUMN is_active;
ALTER TABLE billing_plans
    ADD COLUMN is_active boolean GENERATED ALWAYS AS (status = 'active') STORED;

-- ---------------------------------------------------------------------------
-- 2. businesses.plan now references the one plan domain; `plans` retires.
--    A retired plan key stays a valid FK target on purpose: historical
--    subscriptions keep pointing at it.
-- ---------------------------------------------------------------------------
ALTER TABLE businesses DROP CONSTRAINT businesses_plan_fkey;
ALTER TABLE businesses
    ADD CONSTRAINT businesses_plan_fkey FOREIGN KEY (plan) REFERENCES billing_plans(key);

DROP TABLE plans;

-- ---------------------------------------------------------------------------
-- 3. The subscription lifecycle (migration target for task §19).
--
--    `businesses.plan` stays the quick-lookup column (every reader from
--    plan-limits.ts to the console header depends on it), but the lifecycle
--    lives here: one row per business, explicit statuses, period boundaries,
--    trial/grace ends, auto-renew and cancel-at-period-end.
--
--    Backfill policy — preserve production behaviour: every business gets an
--    `active` subscription on its current plan with a fresh one-month period
--    and auto_renew OFF. Manual plan assignment never charged a recurring
--    fee, so the renewal tick introduced with this migration must not start
--    debiting wallets that never opted in. Renewal only ever touches
--    subscriptions whose auto_renew was explicitly enabled (by a plan
--    purchase or by a super-admin).
-- ---------------------------------------------------------------------------
CREATE TABLE business_subscriptions (
    business_id         uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    plan_key            text NOT NULL REFERENCES billing_plans(key),
    status              text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
    started_at          timestamptz NOT NULL DEFAULT now(),
    current_period_start timestamptz NOT NULL DEFAULT now(),
    current_period_end  timestamptz NOT NULL DEFAULT now() + interval '1 month',
    trial_end           timestamptz,
    grace_end           timestamptz,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    auto_renew          boolean NOT NULL DEFAULT false,
    cancelled_at        timestamptz,
    last_renewal_at     timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_business_subscriptions_renewal_due
    ON business_subscriptions (current_period_end)
    WHERE status IN ('active', 'trialing') AND auto_renew;
CREATE INDEX idx_business_subscriptions_status
    ON business_subscriptions (status);

INSERT INTO business_subscriptions
    (business_id, plan_key, status, started_at, current_period_start, current_period_end, auto_renew)
SELECT b.id, b.plan, 'active', now(), now(), now() + interval '1 month', false
  FROM businesses b
ON CONFLICT (business_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Invoices — the accounting record of what a business was billed.
--
--    `reference` is the idempotency key (unique per business): a renewal
--    claims its invoice row before any money moves, so the same period can
--    never be billed twice. Line items snapshot description + price, so a
--    future plan price change never rewrites a historical invoice.
-- ---------------------------------------------------------------------------
CREATE TABLE billing_invoices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    invoice_number  text NOT NULL,
    status          text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('draft', 'open', 'paid', 'partially_paid', 'overdue', 'void')),
    currency        text NOT NULL DEFAULT 'IRR',
    subtotal_rial   bigint NOT NULL DEFAULT 0 CHECK (subtotal_rial >= 0),
    discount_rial   bigint NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
    tax_rial        bigint NOT NULL DEFAULT 0 CHECK (tax_rial >= 0),
    total_rial      bigint NOT NULL DEFAULT 0 CHECK (total_rial >= 0),
    paid_rial       bigint NOT NULL DEFAULT 0 CHECK (paid_rial >= 0),
    due_at          timestamptz,
    period_start    timestamptz,
    period_end      timestamptz,
    -- e.g. 'subscription-renewal:<period start ISO>' or 'plan-purchase:<payment id>'
    reference       text NOT NULL,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (business_id, reference)
);
CREATE INDEX idx_billing_invoices_business
    ON billing_invoices (business_id, created_at DESC);
CREATE INDEX idx_billing_invoices_status
    ON billing_invoices (status, due_at);

CREATE TABLE billing_invoice_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      uuid NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
    kind            text NOT NULL DEFAULT 'plan'
                        CHECK (kind IN ('plan', 'addon', 'usage', 'adjustment', 'credit')),
    description     text NOT NULL,
    quantity        integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_amount_rial bigint NOT NULL DEFAULT 0 CHECK (unit_amount_rial >= 0),
    amount_rial     bigint NOT NULL DEFAULT 0 CHECK (amount_rial >= 0),
    feature_key     text,
    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_invoice_lines_invoice
    ON billing_invoice_lines (invoice_id, sort_order);

-- Payments may reference the invoice they settled (nullable: wallet top-ups
-- and legacy rows have none).
ALTER TABLE billing_payments
    ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES billing_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_billing_payments_invoice
    ON billing_payments (invoice_id) WHERE invoice_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Auditable per-business commercial overrides (task §25).
--
--    A super-admin exception WITHOUT mutating the global plan: a custom limit
--    or a temporary capability. One row per (business, kind, target); the
--    active flag (rather than a delete) keeps history, and every write is
--    audited in platform_audit_log with before/after values.
-- ---------------------------------------------------------------------------
CREATE TABLE business_billing_overrides (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- 'limit' targets branch_limit/member_limit/monthly_order_limit;
    -- 'capability' targets a feature_flags key.
    kind        text NOT NULL CHECK (kind IN ('limit', 'capability')),
    target      text NOT NULL,
    -- limit: value_int (NULL = unlimited); capability: value_bool.
    value_int   integer,
    value_bool  boolean,
    reason      text NOT NULL CHECK (length(trim(reason)) > 0),
    created_by  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz,
    active      boolean NOT NULL DEFAULT true,
    UNIQUE (business_id, kind, target)
);
CREATE INDEX idx_business_billing_overrides_business
    ON business_billing_overrides (business_id, active, kind);

-- ---------------------------------------------------------------------------
-- 6. RLS — same forced tenant policy as every business-owned billing table
--    (migration 0130's shape).
-- ---------------------------------------------------------------------------
ALTER TABLE business_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_subscriptions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing_invoices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE billing_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoice_lines FORCE ROW LEVEL SECURITY;
-- A line has no business_id of its own: ownership resolves through the
-- parent invoice (the idx on invoice_id keeps the EXISTS cheap).
CREATE POLICY tenant_isolation ON billing_invoice_lines FOR ALL
    USING (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM billing_invoices i
         WHERE i.id = billing_invoice_lines.invoice_id
           AND i.business_id = app_current_business()))
    WITH CHECK (app_rls_bypass() OR EXISTS (
        SELECT 1 FROM billing_invoices i
         WHERE i.id = billing_invoice_lines.invoice_id
           AND i.business_id = app_current_business()));

ALTER TABLE business_billing_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_billing_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_billing_overrides FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
