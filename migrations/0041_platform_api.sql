-- ============================================================================
-- 0041_platform_api.sql — Phase 19 Wave 1: public API foundation
--
-- External integrations are a third authentication realm. API keys identify
-- one business and one branch; they never inherit a staff Role. Every
-- tenant-scoped table below is forced through the standard RLS template in
-- this migration, and the two composite foreign keys prevent accidentally
-- connecting a child row to an endpoint/key from another business.
-- ============================================================================

-- A foreign key from a credential to (location_id, business_id) proves the
-- branch belongs to the credential's business. locations.id is already
-- globally unique; this redundant composite unique index is the PostgreSQL
-- requirement for expressing that stronger cross-column invariant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_id_business
    ON locations (id, business_id);

CREATE TABLE api_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL,
    name        text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    key_prefix  text NOT NULL CHECK (char_length(key_prefix) BETWEEN 10 AND 32),
    key_hash    text NOT NULL UNIQUE CHECK (char_length(key_hash) = 64),
    scopes      text[] NOT NULL CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY[
            'orders.read', 'orders.write', 'menu.read', 'menu.write',
            'inventory.read', 'reports.read', 'webhooks.manage'
        ]::text[]
    ),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    last_used_at timestamptz,
    expires_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz,
    CONSTRAINT api_keys_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT api_keys_id_business_unique UNIQUE (id, business_id),
    CONSTRAINT api_keys_status_revocation_consistent CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    ),
    CONSTRAINT api_keys_expiry_after_creation CHECK (
        expires_at IS NULL OR expires_at > created_at
    )
);
CREATE INDEX idx_api_keys_business_created
    ON api_keys (business_id, created_at DESC);
CREATE INDEX idx_api_keys_location_active
    ON api_keys (location_id, created_at DESC) WHERE status = 'active';

-- This is an operational/audit log, deliberately bounded to state-changing
-- public API requests by the route wrapper that arrives in Wave 2.
CREATE TABLE api_request_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    api_key_id  uuid NOT NULL,
    method      text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
    path        text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 512),
    status_code smallint NOT NULL CHECK (status_code BETWEEN 100 AND 599),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT api_request_log_key_business_fk
        FOREIGN KEY (api_key_id, business_id)
        REFERENCES api_keys (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_api_request_log_business_created
    ON api_request_log (business_id, created_at DESC);
CREATE INDEX idx_api_request_log_key_created
    ON api_request_log (api_key_id, created_at DESC);

CREATE TABLE webhook_endpoints (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id uuid NOT NULL,
    url         text NOT NULL
                    CHECK (char_length(url) <= 2048 AND url ~* '^https?://[^[:space:]]+$'),
    event_types text[] NOT NULL CHECK (
        cardinality(event_types) > 0
        AND event_types <@ ARRAY[
            'order.created', 'order.updated', 'order.paid', 'order_item.status'
        ]::text[]
    ),
    signing_secret text NOT NULL CHECK (char_length(signing_secret) >= 32),
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_success_at timestamptz,
    last_failure_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT webhook_endpoints_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT webhook_endpoints_id_business_unique UNIQUE (id, business_id)
);
CREATE INDEX idx_webhook_endpoints_location_active
    ON webhook_endpoints (location_id, created_at DESC) WHERE status = 'active';

CREATE TABLE webhook_deliveries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    endpoint_id uuid NOT NULL,
    event_type  text NOT NULL CHECK (
        event_type IN ('order.created', 'order.updated', 'order.paid', 'order_item.status')
    ),
    payload     jsonb NOT NULL,
    status      text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    response_status smallint CHECK (response_status BETWEEN 100 AND 599),
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT webhook_deliveries_endpoint_business_fk
        FOREIGN KEY (endpoint_id, business_id)
        REFERENCES webhook_endpoints (id, business_id)
        ON DELETE CASCADE
);
CREATE INDEX idx_webhook_deliveries_due
    ON webhook_deliveries (next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed');
CREATE INDEX idx_webhook_deliveries_endpoint_created
    ON webhook_deliveries (endpoint_id, created_at DESC);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE api_request_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_request_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_request_log FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_endpoints FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Platform-controlled feature flag: disabled by default so no business gets
-- an external integration surface until a platform administrator opts in.
INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES (
    'api_platform',
    'رابط برنامه‌نویسی و وب‌هوک',
    'کلید API برای اتصال امن برنامه‌های جانبی و ارسال وب‌هوک سفارش‌ها',
    false
)
ON CONFLICT (key) DO NOTHING;
