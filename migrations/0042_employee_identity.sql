-- ============================================================================
-- 0042_employee_identity.sql — Phase 20 Wave 1: employee identity foundation
--
-- Today a membership (users row) conflates three things: profile, credential
-- (pin_hash/password_hash), and session (a stateless JWT with no server-side
-- record at all). This wave adds a proper identity substrate underneath that
-- without touching it: employees is a 1:1 profile extension of users
-- (employees.id = users.id, lazily created — see employee-service.ts), and
-- employee_credentials/employee_sessions give every future credential type
-- (PIN today; password/webauthn in later waves per the phase doc) and every
-- session its own row with real metadata (last_used_at, revocation, expiry)
-- instead of one hash column and a bare cookie.
--
-- Deliberately NOT wired into src/app/api/auth/pin-login/route.ts or
-- auth-edge.ts yet — that is Wave 2 (Login Experience Redesign). This wave
-- only adds schema and a service layer, reviewable independently of any
-- change to the live login path, the same staging Phase 19 used for its own
-- key infrastructure before exposing routes.
-- ============================================================================

CREATE TYPE employee_credential_type AS ENUM ('pin', 'password', 'webauthn');

CREATE TABLE employees (
    id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    employee_code text CHECK (employee_code IS NULL OR char_length(trim(employee_code)) BETWEEN 1 AND 40),
    phone         text CHECK (phone IS NULL OR char_length(trim(phone)) BETWEEN 3 AND 32),
    photo_url     text CHECK (photo_url IS NULL OR char_length(photo_url) <= 2048),
    hired_at      date,
    notes         text CHECK (notes IS NULL OR char_length(notes) <= 2000),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT employees_id_business_unique UNIQUE (id, business_id)
);
CREATE INDEX idx_employees_business_code
    ON employees (business_id, employee_code) WHERE employee_code IS NOT NULL;

CREATE TABLE employee_credentials (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL,
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    credential_type employee_credential_type NOT NULL,
    secret_hash     text NOT NULL,
    display_hint    text CHECK (display_hint IS NULL OR char_length(display_hint) <= 32),
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    last_used_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    CONSTRAINT employee_credentials_employee_business_fk
        FOREIGN KEY (employee_id, business_id)
        REFERENCES employees (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT employee_credentials_id_business_unique UNIQUE (id, business_id),
    CONSTRAINT employee_credentials_status_revocation_consistent CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);
-- At most one active credential per (employee, type): issuing a new PIN
-- revokes the old one first rather than leaving two live PINs for one person.
CREATE UNIQUE INDEX idx_employee_credentials_active_type
    ON employee_credentials (employee_id, credential_type) WHERE status = 'active';
CREATE INDEX idx_employee_credentials_business_active
    ON employee_credentials (business_id, credential_type) WHERE status = 'active';

CREATE TABLE employee_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id   uuid,
    credential_id uuid,
    token_hash    text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    device_label  text CHECK (device_label IS NULL OR char_length(device_label) <= 120),
    issued_at     timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    last_seen_at  timestamptz,
    revoked_at    timestamptz,
    CONSTRAINT employee_sessions_employee_business_fk
        FOREIGN KEY (employee_id, business_id)
        REFERENCES employees (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT employee_sessions_credential_business_fk
        FOREIGN KEY (credential_id, business_id)
        REFERENCES employee_credentials (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT employee_sessions_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL,
    CONSTRAINT employee_sessions_expiry_after_issue CHECK (expires_at > issued_at)
);
CREATE INDEX idx_employee_sessions_employee_active
    ON employee_sessions (employee_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX idx_employee_sessions_business_expiry
    ON employee_sessions (business_id, expires_at);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employees FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE employee_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_credentials FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE employee_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_sessions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
