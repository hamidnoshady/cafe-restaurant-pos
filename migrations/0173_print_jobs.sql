-- Print job history and routing rules. Connection jsonb stays the hardware
-- target; rules say which template and printer a document uses.

ALTER TABLE printers
    ADD COLUMN IF NOT EXISTS printer_class text NOT NULL DEFAULT 'thermal',
    ADD COLUMN IF NOT EXISTS supports_drawer boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS supports_cut boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS paper text,
    ADD COLUMN IF NOT EXISTS paper_width_mm smallint,
    ADD COLUMN IF NOT EXISTS fallback_printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_tested_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_test_result text;

UPDATE printers
   SET supports_drawer = COALESCE(connection->>'openDrawer' = 'true', false),
       is_default = COALESCE(connection->>'isDefault' = 'true', false),
       paper = NULLIF(connection->>'paper', ''),
       paper_width_mm = CASE
         WHEN connection->>'paperWidthMm' ~ '^[0-9]+$' THEN (connection->>'paperWidthMm')::int
         ELSE NULL
       END,
       printer_class = CASE
         WHEN connection->>'paper' IN ('a4', 'a5') THEN 'page'
         WHEN connection->>'paper' = 'label57x40' THEN 'label'
         ELSE 'thermal'
       END
 WHERE jsonb_typeof(connection) = 'object';

CREATE TABLE IF NOT EXISTS print_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    document_type text NOT NULL CHECK (document_type IN ('receipt', 'invoice', 'kitchen', 'label')),
    template_key text,
    template_id uuid REFERENCES print_templates(id) ON DELETE SET NULL,
    printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
    fallback_printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, document_type)
);

INSERT INTO print_rules (location_id, document_type, template_key, printer_id)
SELECT DISTINCT ON (location_id, CASE kind::text WHEN 'kitchen' THEN 'kitchen' ELSE 'receipt' END)
       location_id,
       CASE kind::text WHEN 'kitchen' THEN 'kitchen' ELSE 'receipt' END,
       NULLIF(connection->>'templateKey', ''),
       id
  FROM printers
 WHERE is_active
   AND COALESCE(is_default, false)
 ORDER BY location_id, CASE kind::text WHEN 'kitchen' THEN 'kitchen' ELSE 'receipt' END, name
ON CONFLICT (location_id, document_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS print_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    document_type text NOT NULL,
    entity_id text,
    printer_id uuid REFERENCES printers(id) ON DELETE SET NULL,
    template_key text,
    template_version integer,
    status text NOT NULL CHECK (status IN ('created', 'preparing', 'routing', 'sending', 'handed_off', 'failed')),
    error_code text,
    print_request_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    handed_off_at timestamptz,
    UNIQUE (location_id, print_request_id)
);

CREATE INDEX IF NOT EXISTS idx_print_jobs_location_created
    ON print_jobs (location_id, created_at DESC);

ALTER TABLE print_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_rules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON print_rules;
CREATE POLICY tenant_isolation ON print_rules FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

ALTER TABLE print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON print_jobs;
CREATE POLICY tenant_isolation ON print_jobs FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));

ALTER TABLE print_templates
    ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
