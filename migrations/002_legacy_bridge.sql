CREATE TABLE IF NOT EXISTS logistics_legacy_links (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  legacy_type TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  canonical_type TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'LINKED',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, legacy_type, legacy_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_transfer_lines_identity_idx
  ON logistics_transfer_lines (
    transfer_id,
    item_id,
    COALESCE(asset_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

ALTER TABLE logistics_legacy_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_legacy_links FROM anon, authenticated;
