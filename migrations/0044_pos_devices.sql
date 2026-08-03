-- ============================================================================
-- 0044_pos_devices.sql — Phase 20 Wave 4: device binding & security
--
-- Wave 1's open question 1 (restated in the Phase 20 doc's "Open questions
-- for Wave 4"): the employee picker has no server-side notion of "this
-- terminal" beyond the business/location query params, so a biometric prompt
-- is offered for any employee with *any* active webauthn credential, even at
-- a terminal whose fingerprint/face reader never enrolled them. This wave
-- adds a registered device identity a terminal can carry (pos_devices,
-- paired once from an authenticated dashboard session — see
-- src/lib/device-service.ts) plus the FK columns that let the rest of the
-- system attribute a webauthn credential or a session to the device it came
-- from.
--
-- Modeled on employee_sessions (migration 0042): a bearer token, hash-only
-- storage, revocable. Deliberately NOT modeled on employee_credentials'
-- "secret you present back" shape — a device token narrows which options the
-- (still public, still unauthenticated) login picker offers, it is never
-- itself what proves an employee's identity. Losing it degrades a terminal
-- back to Wave 3's unnarrowed behaviour, not to an authentication bypass.
-- ============================================================================

CREATE TABLE pos_devices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id  uuid,
    label        text NOT NULL CHECK (char_length(trim(label)) BETWEEN 1 AND 80),
    token_hash   text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    paired_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    paired_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz,
    revoked_at   timestamptz,
    CONSTRAINT pos_devices_id_business_unique UNIQUE (id, business_id),
    CONSTRAINT pos_devices_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE SET NULL
);
CREATE INDEX idx_pos_devices_business_active
    ON pos_devices (business_id) WHERE revoked_at IS NULL;

ALTER TABLE pos_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pos_devices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Which paired device (if any) a webauthn credential was registered from —
-- null keeps every credential registered before this wave (or from a
-- terminal that was never paired) visible everywhere, exactly as Wave 3 left
-- it; only a device-bound row gets narrowed to that one terminal.
ALTER TABLE employee_credentials
    ADD COLUMN device_id uuid,
    ADD CONSTRAINT employee_credentials_device_business_fk
        FOREIGN KEY (device_id, business_id)
        REFERENCES pos_devices (id, business_id)
        ON DELETE SET NULL;
CREATE INDEX idx_employee_credentials_device
    ON employee_credentials (device_id) WHERE device_id IS NOT NULL;

-- Which paired device (if any) a session was opened from, so revoking a
-- device can also revoke every still-active session it originated —
-- the same "revocation takes effect immediately" property Wave 2 gave
-- employee_sessions itself.
ALTER TABLE employee_sessions
    ADD COLUMN device_id uuid,
    ADD CONSTRAINT employee_sessions_device_business_fk
        FOREIGN KEY (device_id, business_id)
        REFERENCES pos_devices (id, business_id)
        ON DELETE SET NULL;
CREATE INDEX idx_employee_sessions_device
    ON employee_sessions (device_id) WHERE device_id IS NOT NULL;
