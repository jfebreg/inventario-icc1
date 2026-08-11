-- Verificación periódica de disponibilidad e integridad de evidencias.
CREATE TABLE IF NOT EXISTS logistics_evidence_verification_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','PASS','FAIL')),
  requested_count INTEGER NOT NULL DEFAULT 0 CHECK (requested_count >= 0),
  verified_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  corrupt_count INTEGER NOT NULL DEFAULT 0 CHECK (corrupt_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  initiated_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS logistics_evidence_verification_results (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  run_id UUID NOT NULL REFERENCES logistics_evidence_verification_runs(id),
  file_object_id TEXT NOT NULL REFERENCES inventory_file_objects(id),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','MISSING','CORRUPT','ERROR')),
  expected_size BIGINT,
  actual_size BIGINT,
  expected_sha256 TEXT,
  actual_sha256 TEXT,
  provider TEXT,
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id,file_object_id)
);

CREATE OR REPLACE FUNCTION logistics_evidence_verification_results_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los resultados de verificación de evidencias son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_evidence_verification_results_no_change
  ON logistics_evidence_verification_results;
CREATE TRIGGER logistics_evidence_verification_results_no_change
  BEFORE UPDATE OR DELETE ON logistics_evidence_verification_results
  FOR EACH ROW EXECUTE FUNCTION logistics_evidence_verification_results_immutable();

CREATE INDEX IF NOT EXISTS logistics_evidence_verification_runs_date_idx
  ON logistics_evidence_verification_runs (organization_id,started_at DESC);
CREATE INDEX IF NOT EXISTS logistics_evidence_verification_results_file_idx
  ON logistics_evidence_verification_results (file_object_id,checked_at DESC);
CREATE INDEX IF NOT EXISTS logistics_evidence_verification_results_failure_idx
  ON logistics_evidence_verification_results (organization_id,status,checked_at DESC)
  WHERE status <> 'VERIFIED';

ALTER TABLE logistics_evidence_verification_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_evidence_verification_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_evidence_verification_runs,
  logistics_evidence_verification_results FROM anon,authenticated;
