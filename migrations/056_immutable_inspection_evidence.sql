-- Evidencia de inspección inalterable e historial de hallazgos.
CREATE OR REPLACE FUNCTION logistics_reject_inspection_evidence_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La evidencia de inspección enviada es inalterable';
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_answers_no_change ON logistics_inspection_answers;
CREATE TRIGGER logistics_inspection_answers_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_answers
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

DROP TRIGGER IF EXISTS logistics_inspection_template_items_no_change ON logistics_inspection_template_items;
CREATE TRIGGER logistics_inspection_template_items_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_template_items
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

DROP TRIGGER IF EXISTS logistics_inspection_approvals_no_change ON logistics_inspection_approvals;
CREATE TRIGGER logistics_inspection_approvals_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_approvals
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

CREATE OR REPLACE FUNCTION logistics_guard_inspection_template_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Las versiones de plantillas utilizadas no pueden eliminarse';
  END IF;
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
     OR NOT ((OLD.status='DRAFT' AND NEW.status='ACTIVE')
       OR (OLD.status='ACTIVE' AND NEW.status='RETIRED')
       OR OLD.status=NEW.status) THEN
    RAISE EXCEPTION 'Para cambiar una plantilla de inspección debe crearse una nueva versión';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_template_version_guard
  ON logistics_inspection_template_versions;
CREATE TRIGGER logistics_inspection_template_version_guard
  BEFORE UPDATE OR DELETE ON logistics_inspection_template_versions
  FOR EACH ROW EXECUTE FUNCTION logistics_guard_inspection_template_version();

CREATE OR REPLACE FUNCTION logistics_guard_inspection_run_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','approver_profile_id','approved_at','due_at','updated_at']) THEN
    RAISE EXCEPTION 'Los datos originales de la inspección enviada son inalterables';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_run_evidence_guard ON logistics_inspection_runs;
CREATE TRIGGER logistics_inspection_run_evidence_guard
  BEFORE UPDATE ON logistics_inspection_runs
  FOR EACH ROW EXECUTE FUNCTION logistics_guard_inspection_run_evidence();

CREATE TABLE IF NOT EXISTS logistics_inspection_finding_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  inspection_id UUID NOT NULL REFERENCES logistics_inspection_runs(id),
  finding_id UUID NOT NULL REFERENCES logistics_inspection_findings(id),
  event_type TEXT NOT NULL CHECK (event_type IN
    ('SET_DEADLINE','RECORD_CORRECTION','VERIFY_CORRECTION','MAINTENANCE_CORRECTION')),
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  notes TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS logistics_inspection_finding_events_history_idx
  ON logistics_inspection_finding_events (inspection_id,finding_id,occurred_at);

DROP TRIGGER IF EXISTS logistics_inspection_finding_events_no_change
  ON logistics_inspection_finding_events;
CREATE TRIGGER logistics_inspection_finding_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_finding_events
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

ALTER TABLE logistics_inspection_finding_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_inspection_finding_events FROM anon,authenticated;
