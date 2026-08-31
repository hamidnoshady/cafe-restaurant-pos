CREATE TABLE auth_login_attempts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    realm        text NOT NULL CHECK (realm IN ('tenant_password','platform_admin','directory')),
    identity_key text NOT NULL,
    outcome      text NOT NULL CHECK (outcome IN ('failed','success','unlocked')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_login_attempts_lookup ON auth_login_attempts (realm, identity_key, id DESC);