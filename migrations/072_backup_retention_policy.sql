-- Política de retención para respaldos canónicos. No elimina archivos automáticamente.
CREATE TABLE IF NOT EXISTS logistics_backup_retention_policies (
  organization_id UUID PRIMARY KEY REFERENCES logistics_organizations(id),
  daily_days INTEGER NOT NULL DEFAULT 30 CHECK (daily_days BETWEEN 7 AND 365),
  monthly_months INTEGER NOT NULL DEFAULT 12 CHECK (monthly_months BETWEEN 3 AND 120),
  annual_years INTEGER NOT NULL DEFAULT 7 CHECK (annual_years BETWEEN 1 AND 30),
  automatic_deletion BOOLEAN NOT NULL DEFAULT FALSE CHECK (automatic_deletion=FALSE),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO logistics_backup_retention_policies (organization_id)
SELECT id FROM logistics_organizations ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE logistics_backup_retention_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_backup_retention_policies FROM anon,authenticated;
