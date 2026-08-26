CREATE TABLE business_encryption_keys (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    key_version integer NOT NULL,
    wrapped_dek bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_at timestamptz
);
ALTER TABLE business_encryption_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_encryption_keys_tenant_isolation" ON business_encryption_keys
  FOR ALL
  USING (business_id = nullif(current_setting('app.business_id', TRUE), '')::uuid);
