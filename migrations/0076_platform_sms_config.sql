CREATE TABLE platform_sms_config (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    api_key_enc bytea,
    otp_template text,
    updated_at timestamptz NOT NULL DEFAULT now()
);
