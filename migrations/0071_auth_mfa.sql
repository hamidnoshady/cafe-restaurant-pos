CREATE TABLE mfa_enrolments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_realm text NOT NULL CHECK (subject_realm IN ('platform_user','platform_admin')),
    subject_id    uuid NOT NULL,
    method        text NOT NULL CHECK (method IN ('sms_otp','totp')),
    is_primary    boolean NOT NULL DEFAULT false,
    phone_e164    text,
    totp_secret   bytea,
    grace_until   timestamptz,
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject_realm, subject_id, method)
);

CREATE TABLE mfa_challenges (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_realm text NOT NULL,
    subject_id    uuid NOT NULL,
    hashed_otp    text NOT NULL,
    attempts      integer NOT NULL DEFAULT 0,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_realm text NOT NULL,
    subject_id    uuid NOT NULL,
    code_hash     text NOT NULL,
    used_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
