-- Vincula el plan preventivo con el formulario y con la ejecución que realmente lo cumple.
ALTER TABLE logistics_asset_inspection_plans
  ADD COLUMN IF NOT EXISTS required_template_key TEXT;

UPDATE logistics_asset_inspection_plans plan
SET required_template_key=COALESCE(family.inspection_template_legacy_key,
  TRIM(BOTH '-' FROM UPPER(REGEXP_REPLACE('INSPECTION-'||item.sku,'[^A-Za-z0-9]+','-','g'))))
FROM logistics_asset_units unit
JOIN logistics_items item ON item.id=unit.item_id
LEFT JOIN logistics_item_families family ON family.id=item.family_id
WHERE unit.id=plan.asset_unit_id AND plan.required_template_key IS NULL;

ALTER TABLE logistics_asset_inspection_plans
  ALTER COLUMN required_template_key SET NOT NULL;

ALTER TABLE logistics_inspection_runs
  ADD COLUMN IF NOT EXISTS inspection_plan_id UUID
    REFERENCES logistics_asset_inspection_plans(id);

UPDATE logistics_inspection_runs run
SET inspection_plan_id=plan.id
FROM logistics_asset_inspection_plans plan,
     logistics_inspection_template_versions template
WHERE run.inspection_plan_id IS NULL
  AND plan.asset_unit_id=run.asset_unit_id
  AND template.id=run.template_version_id
  AND template.template_key=plan.required_template_key;

CREATE INDEX IF NOT EXISTS logistics_inspection_runs_plan_completed_idx
  ON logistics_inspection_runs (inspection_plan_id,status,approved_at,inspected_at)
  WHERE inspection_plan_id IS NOT NULL;

CREATE OR REPLACE FUNCTION logistics_validate_inspection_plan_execution()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  plan_record RECORD;
  template_record RECORD;
BEGIN
  IF NEW.inspection_plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO plan_record FROM logistics_asset_inspection_plans
    WHERE id=NEW.inspection_plan_id;
  SELECT template_key INTO template_record FROM logistics_inspection_template_versions
    WHERE id=NEW.template_version_id;
  IF plan_record.asset_unit_id<>NEW.asset_unit_id THEN
    RAISE EXCEPTION 'La inspección no corresponde al equipo del plan preventivo';
  END IF;
  IF plan_record.required_template_key<>template_record.template_key THEN
    RAISE EXCEPTION 'El formulario no corresponde al exigido por el plan preventivo';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_plan_execution_guard
  ON logistics_inspection_runs;
CREATE TRIGGER logistics_inspection_plan_execution_guard
BEFORE INSERT OR UPDATE OF inspection_plan_id,template_version_id,asset_unit_id
ON logistics_inspection_runs
FOR EACH ROW EXECUTE FUNCTION logistics_validate_inspection_plan_execution();
