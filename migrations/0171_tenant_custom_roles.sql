-- Tenant-defined permission presets. A custom role is flat (no inheritance)
-- and remains owned by exactly one business. users.role stays as the stable
-- authentication/category fallback; custom_role_id replaces its permission
-- preset only, never Owner semantics.
CREATE TABLE tenant_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_location_scope location_scope NOT NULL DEFAULT 'selected',
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_roles_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    CONSTRAINT tenant_roles_description_length CHECK (char_length(description) <= 500),
    CONSTRAINT tenant_roles_permissions_array CHECK (jsonb_typeof(permissions) = 'array'),
    UNIQUE (business_id, name)
);
CREATE INDEX tenant_roles_business_active_idx ON tenant_roles (business_id, is_active, name);
ALTER TABLE tenant_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_roles FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE users ADD COLUMN custom_role_id uuid REFERENCES tenant_roles(id) ON DELETE RESTRICT;
CREATE INDEX users_custom_role_idx ON users (business_id, custom_role_id) WHERE custom_role_id IS NOT NULL;

-- A composite relationship makes cross-tenant assignment impossible even if a
-- future writer forgets its application-level business predicate.
ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_business_id_id_unique UNIQUE (business_id, id);
ALTER TABLE users ADD CONSTRAINT users_custom_role_same_tenant
    FOREIGN KEY (business_id, custom_role_id)
    REFERENCES tenant_roles (business_id, id)
    DEFERRABLE INITIALLY IMMEDIATE;
