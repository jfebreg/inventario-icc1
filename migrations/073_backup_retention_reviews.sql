-- Decisiones humanas de conservación. Ninguna decisión elimina el respaldo.
CREATE TABLE IF NOT EXISTS logistics_backup_retention_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  backup_manifest_id UUID NOT NULL REFERENCES logistics_backup_manifests(id),
  decision TEXT NOT NULL CHECK (decision IN ('KEEP','ARCHIVE')),
  reason TEXT NOT NULL CHECK (char_length(reason) >= 10),
  reviewed_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS logistics_backup_retention_reviews_manifest_idx
  ON logistics_backup_retention_reviews (organization_id,backup_manifest_id,reviewed_at DESC);

ALTER TABLE logistics_backup_retention_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_backup_retention_reviews FROM anon,authenticated;

CREATE OR REPLACE FUNCTION logistics_backup_retention_review_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Las revisiones de conservación son inmutables';
END;
$$;

DROP TRIGGER IF EXISTS logistics_backup_retention_review_no_change ON logistics_backup_retention_reviews;
CREATE TRIGGER logistics_backup_retention_review_no_change
BEFORE UPDATE OR DELETE ON logistics_backup_retention_reviews
FOR EACH ROW EXECUTE FUNCTION logistics_backup_retention_review_immutable();
