-- Constancias digitales trazables para aceptaciones y aprobaciones operacionales.
CREATE TABLE IF NOT EXISTS logistics_digital_attestations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  attestation_type TEXT NOT NULL CHECK (attestation_type IN
    ('EPP_ACCEPTANCE','INSPECTION_APPROVAL','INSPECTION_CORRECTION_VERIFICATION')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  document_id UUID REFERENCES logistics_documents(id),
  signer_profile_id TEXT REFERENCES inventory_user_profiles(id),
  signer_subject_id TEXT,
  signer_name TEXT NOT NULL,
  signing_method TEXT NOT NULL CHECK (signing_method IN
    ('AUTHENTICATED_SESSION','PUBLIC_SINGLE_USE_TOKEN','SCANNED_SIGNATURE')),
  consent_version TEXT NOT NULL DEFAULT '1.0',
  consent_text_hash TEXT NOT NULL CHECK (consent_text_hash ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  hash_envelope JSONB NOT NULL,
  previous_attestation_hash TEXT CHECK
    (previous_attestation_hash IS NULL OR previous_attestation_hash ~ '^[0-9a-f]{64}$'),
  attestation_hash TEXT NOT NULL UNIQUE CHECK (attestation_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,idempotency_key)
);

CREATE INDEX IF NOT EXISTS logistics_digital_attestations_entity_idx
  ON logistics_digital_attestations (organization_id,entity_type,entity_id,signed_at DESC);
CREATE INDEX IF NOT EXISTS logistics_digital_attestations_signer_idx
  ON logistics_digital_attestations (organization_id,signer_profile_id,signed_at DESC);

CREATE OR REPLACE FUNCTION logistics_digital_attestations_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Las constancias digitales son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_digital_attestations_no_change
  ON logistics_digital_attestations;
CREATE TRIGGER logistics_digital_attestations_no_change
  BEFORE UPDATE OR DELETE ON logistics_digital_attestations
  FOR EACH ROW EXECUTE FUNCTION logistics_digital_attestations_immutable();

ALTER TABLE logistics_digital_attestations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_digital_attestations FROM anon,authenticated;
