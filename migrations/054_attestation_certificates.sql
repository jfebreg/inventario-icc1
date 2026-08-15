-- Amplía constancias ya desplegadas sin alterar la migración 053.
ALTER TABLE logistics_digital_attestations
  DROP CONSTRAINT IF EXISTS logistics_digital_attestations_attestation_type_check;
ALTER TABLE logistics_digital_attestations
  ADD CONSTRAINT logistics_digital_attestations_attestation_type_check
  CHECK (attestation_type IN ('EPP_ACCEPTANCE','INSPECTION_SUBMISSION',
    'INSPECTION_APPROVAL','INSPECTION_CORRECTION_VERIFICATION'));

ALTER TABLE logistics_digital_attestations
  ADD COLUMN IF NOT EXISTS hash_envelope JSONB;

-- Las constancias antiguas conservan su huella original dentro del nuevo sobre.
DROP TRIGGER IF EXISTS logistics_digital_attestations_no_change
  ON logistics_digital_attestations;
UPDATE logistics_digital_attestations
  SET hash_envelope=jsonb_build_object('legacyAttestationHash',attestation_hash)
  WHERE hash_envelope IS NULL;
ALTER TABLE logistics_digital_attestations
  ALTER COLUMN hash_envelope SET NOT NULL;
CREATE TRIGGER logistics_digital_attestations_no_change
  BEFORE UPDATE OR DELETE ON logistics_digital_attestations
  FOR EACH ROW EXECUTE FUNCTION logistics_digital_attestations_immutable();
