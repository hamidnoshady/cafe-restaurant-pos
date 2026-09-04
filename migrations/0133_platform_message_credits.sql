-- ============================================================================
-- 0133_platform_message_credits.sql — Phase 37 Wave 1.
--
-- Platform-owned SMS/email configuration and metered message credits, mirroring
-- Phase 18's AI platform billing (0039_ai_platform_billing.sql) exactly: the
-- platform holds the provider relationship and charges the business metered
-- credits; the business never pastes a provider key of its own.
--
-- The `platform_message_config` singleton carries the active providers and
-- their credentials, encrypted at rest with the realm secret (same scheme as
-- `platform_sms_config`). The two channels are separate because their cost
-- models differ: SMS is metered *per UCS-2 segment* (Persian text — 70 chars
-- per first segment, 67 per subsequent), email is a flat per-send rate. The
-- segment count itself is computed in pure code (messaging-billing-pure.ts)
-- and unit-tested, not guessed here.
--
-- Catalogue/config tables intentionally have no RLS (no tenant column, guarded
-- only by the platform-admin realm). Every business-owned table has its forced
-- tenant policy here, and integration/tenant-isolation asserts it over the live
-- schema. Balances are never a writable column: a balance is always the SUM of
-- the signed `message_credit_ledger`, exactly like `ai_credit_ledger`.
-- ============================================================================

CREATE TABLE platform_message_config (
    id                          boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- Master switch for business-facing message sending. When off, the outbox
    -- drain tick leaves work queued rather than sending.
    enabled                     boolean NOT NULL DEFAULT false,
    -- Provider per channel. The interface is open (src/lib/messaging/provider.ts)
    -- but Kavenegar (sms) and SMTP (email) are what Wave 3 ships, so the column
    -- is a single placeholder that names them rather than an open text slot.
    sms_provider                text NOT NULL DEFAULT 'kavenegar'
                                    CHECK (sms_provider IN ('kavenegar', 'noop')),
    email_provider              text NOT NULL DEFAULT 'smtp'
                                    CHECK (email_provider IN ('smtp', 'noop')),
    -- Credentials, AES-256-GCM encrypted (realm secret), same envelope as
    -- platform_sms_config.api_key_enc. Never returned to any business.
    kavenegar_api_key_enc       bytea,
    kavenegar_sender            text NOT NULL DEFAULT '',
    smtp_host                   text NOT NULL DEFAULT '',
    smtp_port                   integer NOT NULL DEFAULT 587,
    smtp_secure                 boolean NOT NULL DEFAULT false,
    smtp_user                   text NOT NULL DEFAULT '',
    smtp_password_enc           bytea,
    smtp_from                   text NOT NULL DEFAULT '',
    -- Rial per SMS *segment* and per email. SMS is a true metered cost; email
    -- is charged flat regardless of body length.
    sms_rial_per_segment        bigint NOT NULL DEFAULT 0 CHECK (sms_rial_per_segment >= 0),
    email_rial_per_send         bigint NOT NULL DEFAULT 0 CHECK (email_rial_per_send >= 0),
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_credit_packages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                text NOT NULL CHECK (length(trim(name)) > 0),
    price_rial          bigint NOT NULL CHECK (price_rial > 0),
    credit_amount_rial  bigint NOT NULL CHECK (credit_amount_rial > 0),
    is_active           boolean NOT NULL DEFAULT true,
    sort_order          integer NOT NULL DEFAULT 0,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_credit_packages_catalogue
    ON message_credit_packages (is_active, sort_order, created_at);

CREATE TABLE message_business_billing (
    business_id   uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    balance_rial  bigint NOT NULL DEFAULT 0 CHECK (balance_rial >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE message_credit_ledger (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    kind                  text NOT NULL CHECK (kind IN (
                              'manual_grant',
                              'top_up',
                              'usage',
                              'usage_refund'
                          )),
    -- Positive for credits granted/restored, negative for spend reserved.
    amount_rial           bigint NOT NULL,
    -- What sending actually cost the platform (per segment × rate); recorded
    -- at settle so the platform can see margin next to what the business paid.
    actual_cost_rial      bigint CHECK (actual_cost_rial IS NULL OR actual_cost_rial >= 0),
    request_id            uuid,
    note                  text,
    metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    platform_admin_id     uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_credit_ledger_business_created
    ON message_credit_ledger (business_id, created_at DESC);
CREATE INDEX idx_message_credit_ledger_request
    ON message_credit_ledger (request_id) WHERE request_id IS NOT NULL;
-- One live spend reservation per request id; `usage` rows are the reservation
-- that settle/refund later mutate against.
CREATE UNIQUE INDEX idx_message_credit_ledger_one_usage_reservation
    ON message_credit_ledger (request_id) WHERE kind = 'usage';

CREATE TABLE message_top_up_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    package_id            uuid REFERENCES message_credit_packages(id) ON DELETE SET NULL,
    package_name          text NOT NULL,
    price_rial            bigint NOT NULL CHECK (price_rial > 0),
    credit_amount_rial    bigint NOT NULL CHECK (credit_amount_rial > 0),
    note                  text,
    status                text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by           uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
    reviewed_at           timestamptz,
    fulfilled_ledger_id   uuid REFERENCES message_credit_ledger(id) ON DELETE SET NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_top_up_requests_pending
    ON message_top_up_requests (status, created_at) WHERE status = 'pending';
CREATE INDEX idx_message_top_up_requests_business_created
    ON message_top_up_requests (business_id, created_at DESC);

ALTER TABLE message_business_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_business_billing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_business_billing FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE message_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_credit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_credit_ledger FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE message_top_up_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_top_up_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_top_up_requests FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
