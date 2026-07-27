-- Manifiestos inmutables de exportaciones de recuperación V2.
CREATE TABLE IF NOT EXISTS logistics_backup_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  format_version TEXT NOT NULL DEFAULT 'ICC-LOGISTICS-BACKUP-1',
  generated_by TEXT REFERENCES inventory_user_profiles(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  audit_head_hash TEXT,
  audit_chain_valid BOOLEAN NOT NULL,
  record_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS logistics_backup_manifests_org_date_idx
  ON logistics_backup_manifests (organization_id, generated_at DESC);

DROP TRIGGER IF EXISTS logistics_backup_manifest_immutable ON logistics_backup_manifests;
CREATE TRIGGER logistics_backup_manifest_immutable
  BEFORE UPDATE OR DELETE ON logistics_backup_manifests
  FOR EACH ROW EXECUTE FUNCTION logistics_reject_immutable_change();

ALTER TABLE logistics_backup_manifests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_backup_manifests FROM anon, authenticated;
