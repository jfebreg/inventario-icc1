-- Evidencia formal de pruebas de recuperación y objetivos RPO/RTO.
CREATE TABLE IF NOT EXISTS logistics_recovery_drills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  drill_number TEXT NOT NULL,
  drill_type TEXT NOT NULL
    CHECK (drill_type IN ('TABLETOP','EXPORT_VERIFY','ISOLATED_RESTORE')),
  environment TEXT NOT NULL DEFAULT 'isolated',
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','IN_PROGRESS','PASSED','FAILED','CANCELLED')),
  backup_manifest_id UUID REFERENCES logistics_backup_manifests(id),
  target_rpo_minutes INTEGER NOT NULL CHECK (target_rpo_minutes > 0),
  target_rto_minutes INTEGER NOT NULL CHECK (target_rto_minutes > 0),
  measured_rpo_minutes INTEGER CHECK (measured_rpo_minutes >= 0),
  measured_rto_minutes INTEGER CHECK (measured_rto_minutes >= 0),
  scope TEXT NOT NULL,
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings TEXT,
  corrective_actions TEXT,
  evidence_file_id TEXT REFERENCES inventory_file_objects(id),
  owner_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  reviewed_by TEXT REFERENCES inventory_user_profiles(id),
  planned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,drill_number)
);

CREATE INDEX IF NOT EXISTS logistics_recovery_drills_status_idx
  ON logistics_recovery_drills (organization_id,status,planned_at DESC);

ALTER TABLE logistics_recovery_drills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_recovery_drills FROM anon,authenticated;
