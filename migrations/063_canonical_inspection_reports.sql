CREATE TABLE IF NOT EXISTS logistics_inspection_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  inspection_id UUID NOT NULL REFERENCES logistics_inspection_runs(id),
  document_id UUID NOT NULL REFERENCES logistics_documents(id),
  report_sha256 TEXT NOT NULL CHECK (report_sha256 ~ '^[0-9a-f]{64}$'),
  generated_by TEXT REFERENCES inventory_user_profiles(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inspection_id)
);

CREATE INDEX IF NOT EXISTS logistics_inspection_reports_org_date_idx
  ON logistics_inspection_reports (organization_id,generated_at DESC);

DROP TRIGGER IF EXISTS logistics_inspection_reports_no_change
  ON logistics_inspection_reports;
CREATE TRIGGER logistics_inspection_reports_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_reports
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

ALTER TABLE logistics_inspection_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_inspection_reports FROM anon,authenticated;

COMMENT ON TABLE logistics_inspection_reports IS
  'Una única versión final e inmutable del informe PDF de cada inspección aprobada o cerrada.';
