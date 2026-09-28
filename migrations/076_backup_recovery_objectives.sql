-- Objetivos organizacionales para la recuperación automática de respaldos.
CREATE TABLE IF NOT EXISTS logistics_backup_recovery_objectives (
  organization_id UUID PRIMARY KEY REFERENCES logistics_organizations(id),
  target_rpo_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (target_rpo_minutes BETWEEN 5 AND 10080),
  target_rto_minutes INTEGER NOT NULL DEFAULT 240 CHECK (target_rto_minutes BETWEEN 1 AND 1440),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO logistics_backup_recovery_objectives (organization_id)
SELECT id FROM logistics_organizations ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE logistics_backup_recovery_objectives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_backup_recovery_objectives FROM anon,authenticated;
