-- Gobierno de versiones y despliegues verificables.
CREATE TABLE IF NOT EXISTS logistics_release_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  release_key TEXT NOT NULL,
  version_label TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  service_id TEXT,
  environment TEXT NOT NULL DEFAULT 'production',
  status TEXT NOT NULL DEFAULT 'DEPLOYED'
    CHECK (status IN ('DEPLOYED','VALIDATING','APPROVED','FAILED','ROLLED_BACK')),
  latest_migration TEXT,
  deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  rollback_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,release_key)
);

CREATE TABLE IF NOT EXISTS logistics_release_checks (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  release_id UUID NOT NULL REFERENCES logistics_release_records(id),
  check_code TEXT NOT NULL,
  mandatory BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL CHECK (status IN ('PASS','WARN','FAIL')),
  detail TEXT,
  measured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  measured_by TEXT REFERENCES inventory_user_profiles(id)
);

CREATE OR REPLACE FUNCTION logistics_release_checks_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Las verificaciones de despliegue son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_release_checks_no_change ON logistics_release_checks;
CREATE TRIGGER logistics_release_checks_no_change
  BEFORE UPDATE OR DELETE ON logistics_release_checks
  FOR EACH ROW EXECUTE FUNCTION logistics_release_checks_immutable();

CREATE UNIQUE INDEX IF NOT EXISTS logistics_one_approved_release_idx
  ON logistics_release_records (organization_id)
  WHERE status='APPROVED';
CREATE INDEX IF NOT EXISTS logistics_release_records_date_idx
  ON logistics_release_records (organization_id,deployed_at DESC);
CREATE INDEX IF NOT EXISTS logistics_release_checks_release_idx
  ON logistics_release_checks (release_id,measured_at DESC);

ALTER TABLE logistics_release_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_release_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_release_records,logistics_release_checks FROM anon,authenticated;
