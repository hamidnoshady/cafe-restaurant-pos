-- 0172_deployment_profiles.sql
-- Replace the ambiguous per-business deployment.mode payload and the
-- misleading offline_mode entitlement. Runtime role remains process config;
-- connectivity remains runtime state.

INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES ('site_cloud_sync', 'همگام‌سازی سایت و ابر', 'همگام‌سازی امن سرور محلی با سکوی ابری', true)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO business_features (business_id, flag_key, enabled, updated_at)
SELECT business_id, 'site_cloud_sync', enabled, updated_at
FROM business_features
WHERE flag_key = 'offline_mode'
ON CONFLICT (business_id, flag_key) DO UPDATE
SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;

-- A stored connected value only existed on paired site installations. Central
-- cloud tenants historically had no deployment.mode row and are inferred as
-- cloud from the process role, so this conversion never guesses for them.
INSERT INTO settings (business_id, location_id, key, value, updated_at)
SELECT business_id, NULL, 'deployment.profile',
       jsonb_build_object(
         'profile', CASE value->>'mode' WHEN 'local' THEN 'local' ELSE 'hybrid' END,
         'pairedAt', value->'pairedAt'
       ),
       updated_at
FROM settings
WHERE location_id IS NULL
  AND key = 'deployment.mode'
  AND value->>'mode' IN ('local', 'connected')
ON CONFLICT (business_id, location_id, key) DO UPDATE
SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

-- Keep old rows/flag catalogue entries temporarily: older desktop binaries
-- still read them. New code has exactly one compatibility reader and never
-- writes either legacy spelling.
