-- Asignación formal, SLA y escalación de revisiones de inspección.
ALTER TABLE logistics_inspection_runs
  ADD COLUMN IF NOT EXISTS assigned_reviewer_profile_id TEXT REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS review_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS review_escalated_at TIMESTAMPTZ;

ALTER TABLE logistics_inspection_runs
  DROP CONSTRAINT IF EXISTS logistics_inspection_runs_review_status_check;
ALTER TABLE logistics_inspection_runs
  ADD CONSTRAINT logistics_inspection_runs_review_status_check
  CHECK (review_status IN ('PENDING','IN_REVIEW','WAITING_CORRECTION','COMPLETED','ESCALATED'));

UPDATE logistics_inspection_runs
SET review_due_at=COALESCE(review_due_at,submitted_at+INTERVAL '24 hours'),
    review_status=CASE
      WHEN status IN ('APPROVED','CLOSED') THEN 'COMPLETED'
      WHEN status='CORRECTION_PENDING' THEN 'WAITING_CORRECTION'
      ELSE review_status END
WHERE review_due_at IS NULL OR review_status='PENDING';

CREATE INDEX IF NOT EXISTS logistics_inspection_review_due_idx
  ON logistics_inspection_runs (organization_id,review_status,review_due_at)
  WHERE review_status NOT IN ('COMPLETED');

-- Amplía únicamente los campos de flujo permitidos; la evidencia original sigue protegida.
CREATE OR REPLACE FUNCTION logistics_guard_inspection_run_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at',
      'assigned_reviewer_profile_id','review_due_at','review_status','review_escalated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at',
      'assigned_reviewer_profile_id','review_due_at','review_status','review_escalated_at']) THEN
    RAISE EXCEPTION 'Los datos originales de la inspección enviada son inalterables';
  END IF;
  RETURN NEW;
END $$;
