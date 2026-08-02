-- ============================================================================
-- 0043_employee_webauthn_credentials.sql — Phase 20 Wave 3: biometric
-- authentication (WebAuthn)
--
-- Wave 1's employee_credentials already reserved the 'webauthn' enum value,
-- but its only storage column (secret_hash) is shaped for a bcrypt hash a
-- presented secret can be compared against — WebAuthn instead needs to keep
-- the authenticator's public key around so a signed assertion can be
-- verified against it, plus the credential ID the browser hands back on
-- login and a signature counter to detect a cloned authenticator. None of
-- that is a "secret" at all (public keys are, by definition, public), so it
-- doesn't belong in secret_hash — these are new, WebAuthn-only columns,
-- nullable for the 'pin'/'password' rows that don't use them.
-- ============================================================================

ALTER TABLE employee_credentials
    ADD COLUMN webauthn_credential_id text
        CHECK (webauthn_credential_id IS NULL OR char_length(webauthn_credential_id) <= 512),
    ADD COLUMN webauthn_public_key text,
    ADD COLUMN webauthn_sign_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN webauthn_transports text[];

-- secret_hash was NOT NULL for every row when only 'pin'/'password' existed;
-- a 'webauthn' row has no secret_hash at all (there is no bcrypt-comparable
-- secret) but must carry its own two required columns instead.
ALTER TABLE employee_credentials ALTER COLUMN secret_hash DROP NOT NULL;
ALTER TABLE employee_credentials ADD CONSTRAINT employee_credentials_type_storage_shape CHECK (
    (credential_type = 'webauthn'
        AND secret_hash IS NULL
        AND webauthn_credential_id IS NOT NULL
        AND webauthn_public_key IS NOT NULL)
    OR (credential_type <> 'webauthn'
        AND secret_hash IS NOT NULL
        AND webauthn_credential_id IS NULL
        AND webauthn_public_key IS NULL)
);

-- Credential IDs are authenticator-generated random byte strings (effectively
-- never colliding), but a unique index is cheap insurance against a spoofed
-- or replayed one being registered under a second identity.
CREATE UNIQUE INDEX idx_employee_credentials_webauthn_credential_id
    ON employee_credentials (webauthn_credential_id) WHERE webauthn_credential_id IS NOT NULL;

-- Wave 1's "at most one active credential per (employee, type)" index applied
-- to the whole enum, which is right for 'pin' (one shared secret, so issuing
-- a new one should retire the old) but wrong for 'webauthn': a POS runs on
-- several shared terminals per branch, and an employee who works more than
-- one of them needs a separate registered authenticator (the terminal's own
-- fingerprint/face reader) per terminal, live at the same time. Narrow the
-- original index to stop covering 'webauthn' rather than dropping the
-- one-PIN-at-a-time guarantee it still provides for 'pin'/'password'.
DROP INDEX idx_employee_credentials_active_type;
CREATE UNIQUE INDEX idx_employee_credentials_active_type
    ON employee_credentials (employee_id, credential_type)
    WHERE status = 'active' AND credential_type <> 'webauthn';
