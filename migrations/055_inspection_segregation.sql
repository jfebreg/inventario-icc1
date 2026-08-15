-- Segregación obligatoria entre quien inspecciona y quien aprueba.
CREATE OR REPLACE FUNCTION logistics_guard_inspection_run_separation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inspector_profile_id IS NOT NULL
     AND NEW.approver_profile_id IS NOT NULL
     AND NEW.inspector_profile_id = NEW.approver_profile_id THEN
    RAISE EXCEPTION 'El inspector no puede aprobar su propia inspección';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_run_separation ON logistics_inspection_runs;
CREATE TRIGGER logistics_inspection_run_separation
  BEFORE INSERT OR UPDATE OF inspector_profile_id,approver_profile_id
  ON logistics_inspection_runs
  FOR EACH ROW EXECUTE FUNCTION logistics_guard_inspection_run_separation();

CREATE OR REPLACE FUNCTION logistics_guard_inspection_approval_separation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM logistics_inspection_runs inspection
    WHERE inspection.id=NEW.inspection_id
      AND inspection.inspector_profile_id IS NOT NULL
      AND inspection.inspector_profile_id=NEW.approver_profile_id
  ) THEN
    RAISE EXCEPTION 'El inspector no puede decidir sobre su propia inspección';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_approval_separation ON logistics_inspection_approvals;
CREATE TRIGGER logistics_inspection_approval_separation
  BEFORE INSERT OR UPDATE OF inspection_id,approver_profile_id
  ON logistics_inspection_approvals
  FOR EACH ROW EXECUTE FUNCTION logistics_guard_inspection_approval_separation();
