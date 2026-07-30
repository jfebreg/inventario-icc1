-- Corte controlado desde el respaldo heredado hacia el libro mayor canónico.
CREATE TABLE IF NOT EXISTS logistics_cutover_controls (
  organization_id UUID PRIMARY KEY REFERENCES logistics_organizations(id),
  mode TEXT NOT NULL DEFAULT 'DUAL_WRITE'
    CHECK (mode IN ('LEGACY_PRIMARY','DUAL_WRITE','CANONICAL_PRIMARY')),
  required_clean_reconciliations INTEGER NOT NULL DEFAULT 3
    CHECK (required_clean_reconciliations BETWEEN 1 AND 30),
  consecutive_clean_reconciliations INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_clean_reconciliations >= 0),
  last_reconciliation_ok BOOLEAN,
  last_reconciled_at TIMESTAMPTZ,
  last_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  canonical_activated_at TIMESTAMPTZ,
  canonical_activated_by TEXT,
  last_rollback_at TIMESTAMPTZ,
  last_rollback_by TEXT,
  last_rollback_reason TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO logistics_cutover_controls (organization_id,mode)
SELECT id,'DUAL_WRITE' FROM logistics_organizations
ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE logistics_cutover_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_cutover_controls FROM anon, authenticated;
