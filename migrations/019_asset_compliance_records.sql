-- Cumplimiento técnico y documental por unidad serializada.
CREATE TABLE IF NOT EXISTS logistics_asset_compliance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  compliance_type TEXT NOT NULL CHECK (compliance_type IN (
    'CERTIFICATION','CALIBRATION','WARRANTY','INSURANCE',
    'PERMIT','INSPECTION_CERTIFICATE','OTHER'
  )),
  requirement_name TEXT NOT NULL,
  issuer TEXT,
  document_number TEXT,
  issued_at DATE,
  expires_at DATE,
  reminder_days INTEGER NOT NULL DEFAULT 30 CHECK (reminder_days BETWEEN 0 AND 365),
  critical BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RENEWED','REVOKED','CANCELLED')),
  canonical_document_id UUID REFERENCES logistics_documents(id),
  supersedes_id UUID REFERENCES logistics_asset_compliance_records(id),
  notes TEXT,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_asset_compliance_document_idx
  ON logistics_asset_compliance_records
  (organization_id, asset_unit_id, compliance_type, document_number)
  WHERE document_number IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS logistics_asset_compliance_expiry_idx
  ON logistics_asset_compliance_records
  (organization_id, status, expires_at)
  WHERE status='ACTIVE';

CREATE INDEX IF NOT EXISTS logistics_asset_compliance_unit_idx
  ON logistics_asset_compliance_records (asset_unit_id, created_at DESC);

ALTER TABLE logistics_asset_compliance_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_asset_compliance_records FROM anon, authenticated;
