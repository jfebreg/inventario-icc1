ALTER TABLE logistics_custody_assignments
  ADD COLUMN IF NOT EXISTS external_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS logistics_custody_external_reference_idx
  ON logistics_custody_assignments (organization_id, external_reference)
  WHERE external_reference IS NOT NULL AND BTRIM(external_reference) <> '';

CREATE INDEX IF NOT EXISTS logistics_custody_active_idx
  ON logistics_custody_assignments (organization_id, warehouse_id, status, created_at DESC);

ALTER TABLE logistics_custody_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_custody_assignments FROM anon, authenticated;
