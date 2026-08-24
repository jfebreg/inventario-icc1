-- La inspección puede registrarse antes de terminar la carga, pero no aprobarse sin evidencia archivada.
ALTER TABLE logistics_inspection_runs
  ADD COLUMN IF NOT EXISTS evidence_required BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS evidence_status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS evidence_document_id UUID REFERENCES logistics_documents(id),
  ADD COLUMN IF NOT EXISTS evidence_linked_at TIMESTAMPTZ;

ALTER TABLE logistics_inspection_runs
  DROP CONSTRAINT IF EXISTS logistics_inspection_runs_evidence_status_check;
ALTER TABLE logistics_inspection_runs
  ADD CONSTRAINT logistics_inspection_runs_evidence_status_check
  CHECK (evidence_status IN ('PENDING','VERIFIED','FAILED'));

WITH latest_evidence AS (
  SELECT DISTINCT ON (link.entity_id) link.entity_id,link.document_id
  FROM logistics_document_links link
  JOIN logistics_documents document ON document.id=link.document_id AND document.status='ACTIVE'
  WHERE link.entity_type='inspection_run' AND link.relationship='EVIDENCE'
  ORDER BY link.entity_id,document.created_at DESC
)
UPDATE logistics_inspection_runs inspection
SET evidence_status='VERIFIED',evidence_document_id=linked.document_id,
    evidence_linked_at=COALESCE(inspection.evidence_linked_at,NOW())
FROM latest_evidence linked
WHERE inspection.evidence_status<>'VERIFIED' AND inspection.id::text=linked.entity_id;

CREATE INDEX IF NOT EXISTS logistics_inspection_evidence_pending_idx
  ON logistics_inspection_runs (organization_id,created_at)
  WHERE evidence_required=TRUE AND evidence_status<>'VERIFIED';

-- Amplía únicamente los campos de flujo; respuestas, resultado e identidad siguen inmutables.
CREATE OR REPLACE FUNCTION logistics_guard_inspection_run_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at',
      'assigned_reviewer_profile_id','review_due_at','review_status','review_escalated_at',
      'evidence_status','evidence_document_id','evidence_linked_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at',
      'assigned_reviewer_profile_id','review_due_at','review_status','review_escalated_at',
      'evidence_status','evidence_document_id','evidence_linked_at']) THEN
    RAISE EXCEPTION 'Los datos originales de la inspección enviada son inalterables';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION logistics_require_inspection_evidence_before_approval()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPROVED','CLOSED') AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.evidence_required=TRUE AND NEW.evidence_status<>'VERIFIED' THEN
    RAISE EXCEPTION 'La inspección no puede aprobarse sin evidencia digital verificada';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_requires_evidence ON logistics_inspection_runs;
CREATE TRIGGER logistics_inspection_requires_evidence
  BEFORE UPDATE OF status ON logistics_inspection_runs
  FOR EACH ROW EXECUTE FUNCTION logistics_require_inspection_evidence_before_approval();
