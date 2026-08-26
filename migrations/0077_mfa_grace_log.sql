CREATE TABLE mfa_grace_periods (
    subject_realm text NOT NULL CHECK (subject_realm IN ('platform_user','platform_admin')),
    subject_id    uuid NOT NULL,
    grace_until   timestamptz NOT NULL,
    PRIMARY KEY (subject_realm, subject_id)
);
