-- Audited current-position cutover. Historical COGS is classified, never
-- reconstructed from today's recipes.

INSERT INTO accounts(business_id,code,name,type)
SELECT id,'3950','Historical Inventory Reconciliation Equity','equity'
FROM businesses
ON CONFLICT (business_id,code) DO NOTHING;

CREATE TYPE inventory_history_classification AS ENUM ('exact','source_backed','unavailable');
CREATE TYPE inventory_cutover_status AS ENUM ('applying','applied','failed');

CREATE TABLE inventory_cutovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL,
  approved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  backup_confirmation text NOT NULL CHECK (length(trim(backup_confirmation)) >= 8),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status inventory_cutover_status NOT NULL DEFAULT 'applying',
  inventory_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
  reconciliation_journal_id uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id),
  UNIQUE (business_id,evidence_sha256)
);

CREATE TABLE inventory_cutover_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cutover_id uuid NOT NULL REFERENCES inventory_cutovers(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  source_classification inventory_history_classification NOT NULL,
  physical_quantity numeric(24,9) NOT NULL CHECK (physical_quantity >= 0),
  carrying_value_rial bigint NOT NULL CHECK (carrying_value_rial >= 0),
  prior_physical_quantity numeric(24,9) NOT NULL,
  prior_subledger_value_rial bigint NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cutover_id,inventory_item_id)
);

CREATE TABLE inventory_history_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cutover_id uuid NOT NULL REFERENCES inventory_cutovers(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (source_type IN ('order','purchase','opening','negative_settlement')),
  source_id uuid NOT NULL,
  classification inventory_history_classification NOT NULL,
  cogs_available boolean NOT NULL,
  reason text NOT NULL,
  linked_inventory_event_id uuid REFERENCES inventory_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cutover_id,source_type,source_id),
  CHECK (classification <> 'unavailable' OR cogs_available = false)
);
CREATE INDEX idx_history_coverage_location ON inventory_history_coverage(location_id,classification);

CREATE VIEW v_inventory_history_coverage AS
SELECT h.location_id,c.business_id,c.effective_at,
       h.source_type,h.classification::text classification,h.cogs_available,
       count(*)::bigint source_count
FROM inventory_history_coverage h
JOIN inventory_cutovers c ON c.id=h.cutover_id
WHERE c.status='applied'
GROUP BY h.location_id,c.business_id,c.effective_at,
         h.source_type,h.classification,h.cogs_available;

CREATE OR REPLACE FUNCTION protect_applied_inventory_cutover()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cutover_status inventory_cutover_status;
BEGIN
  IF TG_TABLE_NAME = 'inventory_cutovers' THEN
    cutover_status := OLD.status;
  ELSE
    SELECT status INTO cutover_status FROM inventory_cutovers
     WHERE id=OLD.cutover_id;
  END IF;
  IF cutover_status = 'applied' THEN
    RAISE EXCEPTION 'applied inventory cutover records are immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER trg_inventory_cutovers_immutable
  BEFORE UPDATE OR DELETE ON inventory_cutovers
  FOR EACH ROW EXECUTE FUNCTION protect_applied_inventory_cutover();
CREATE TRIGGER trg_inventory_cutover_lines_immutable
  BEFORE UPDATE OR DELETE ON inventory_cutover_lines
  FOR EACH ROW EXECUTE FUNCTION protect_applied_inventory_cutover();
CREATE TRIGGER trg_inventory_history_coverage_immutable
  BEFORE UPDATE OR DELETE ON inventory_history_coverage
  FOR EACH ROW EXECUTE FUNCTION protect_applied_inventory_cutover();
