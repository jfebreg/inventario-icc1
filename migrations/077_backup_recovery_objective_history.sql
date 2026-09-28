-- Historial inmutable de objetivos organizacionales de recuperación.
CREATE TABLE IF NOT EXISTS logistics_backup_recovery_objective_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  previous_rpo_minutes INTEGER,
  previous_rto_minutes INTEGER,
  target_rpo_minutes INTEGER NOT NULL,
  target_rto_minutes INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) >= 10),
  changed_by TEXT REFERENCES inventory_user_profiles(id),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS logistics_backup_recovery_objective_history_idx
  ON logistics_backup_recovery_objective_history (organization_id,changed_at DESC);

INSERT INTO logistics_backup_recovery_objective_history
  (organization_id,target_rpo_minutes,target_rto_minutes,reason,changed_by)
SELECT organization_id,target_rpo_minutes,target_rto_minutes,
  'Valor inicial migrado desde la política vigente.',updated_by
FROM logistics_backup_recovery_objectives objective
WHERE NOT EXISTS (SELECT 1 FROM logistics_backup_recovery_objective_history history
  WHERE history.organization_id=objective.organization_id);

ALTER TABLE logistics_backup_recovery_objective_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_backup_recovery_objective_history FROM anon,authenticated;

CREATE OR REPLACE FUNCTION logistics_backup_recovery_objective_history_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El historial de objetivos de recuperación es inmutable';
END;
$$;

DROP TRIGGER IF EXISTS logistics_backup_recovery_objective_history_no_change
  ON logistics_backup_recovery_objective_history;
CREATE TRIGGER logistics_backup_recovery_objective_history_no_change
BEFORE UPDATE OR DELETE ON logistics_backup_recovery_objective_history
FOR EACH ROW EXECUTE FUNCTION logistics_backup_recovery_objective_history_immutable();
