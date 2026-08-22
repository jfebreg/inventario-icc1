-- Gobierno de formularios: borrador, aprobación independiente y publicación controlada.
DROP TRIGGER IF EXISTS logistics_inspection_template_version_guard
  ON logistics_inspection_template_versions;

ALTER TABLE logistics_inspection_template_versions
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS definition_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS approval_mode TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS change_reason TEXT;

ALTER TABLE logistics_inspection_template_versions
  DROP CONSTRAINT IF EXISTS logistics_inspection_template_versions_approval_mode_check;
ALTER TABLE logistics_inspection_template_versions
  ADD CONSTRAINT logistics_inspection_template_versions_approval_mode_check
  CHECK (approval_mode IN ('PENDING','MANUAL','LEGACY'));

UPDATE logistics_inspection_template_versions
SET approval_mode=CASE WHEN status IN ('ACTIVE','RETIRED') THEN 'LEGACY' ELSE 'PENDING' END,
    submitted_at=COALESCE(submitted_at,created_at)
WHERE approval_mode='PENDING' OR submitted_at IS NULL;

WITH duplicate_active AS (
  SELECT id,ROW_NUMBER() OVER (
    PARTITION BY organization_id,template_key ORDER BY version DESC,created_at DESC,id DESC) AS position
  FROM logistics_inspection_template_versions WHERE status='ACTIVE'
)
UPDATE logistics_inspection_template_versions version
SET status='RETIRED'
FROM duplicate_active duplicate
WHERE version.id=duplicate.id AND duplicate.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS logistics_inspection_template_one_active_idx
  ON logistics_inspection_template_versions (organization_id,template_key)
  WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS logistics_inspection_template_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  template_version_id UUID NOT NULL REFERENCES logistics_inspection_template_versions(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('DRAFT_CREATED','APPROVED','RETIRED')),
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  definition_sha256 TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_guard_inspection_template_version()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Las versiones de plantillas no pueden eliminarse';
  END IF;
  IF OLD.status='DRAFT' AND NEW.status='ACTIVE' THEN
    IF (to_jsonb(NEW)-ARRAY['status','approved_by','approved_at','definition_sha256','approval_mode'])
       IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','approved_by','approved_at','definition_sha256','approval_mode']) THEN
      RAISE EXCEPTION 'La definición del borrador no puede modificarse durante su aprobación';
    END IF;
    IF NEW.approval_mode<>'MANUAL' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
       OR COALESCE(NEW.definition_sha256,'')='' OR NEW.approved_by=NEW.created_by THEN
      RAISE EXCEPTION 'La publicación requiere aprobación independiente y huella de la definición';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='ACTIVE' AND NEW.status='RETIRED' THEN
    IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
      RAISE EXCEPTION 'Retirar una plantilla no permite alterar su evidencia';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Para cambiar una plantilla debe crearse y aprobarse una versión nueva';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER logistics_inspection_template_version_guard
  BEFORE UPDATE OR DELETE ON logistics_inspection_template_versions
  FOR EACH ROW EXECUTE FUNCTION logistics_guard_inspection_template_version();

DROP TRIGGER IF EXISTS logistics_inspection_template_events_no_change
  ON logistics_inspection_template_events;
CREATE TRIGGER logistics_inspection_template_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_inspection_template_events
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_evidence_change();

ALTER TABLE logistics_inspection_template_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_inspection_template_events FROM anon,authenticated;
