-- Gobierno de conservación documental y bloqueos legales.
CREATE TABLE IF NOT EXISTS logistics_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  document_type TEXT NOT NULL,
  retention_years INTEGER NOT NULL CHECK (retention_years BETWEEN 1 AND 30),
  disposition TEXT NOT NULL DEFAULT 'REVIEW'
    CHECK (disposition IN ('REVIEW','ARCHIVE')),
  legal_basis TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,document_type)
);

CREATE TABLE IF NOT EXISTS logistics_legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  hold_number TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  document_type TEXT,
  entity_type TEXT,
  entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','RELEASED')),
  placed_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by TEXT REFERENCES inventory_user_profiles(id),
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,hold_number)
);

CREATE TABLE IF NOT EXISTS logistics_retention_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  candidate_count INTEGER NOT NULL DEFAULT 0,
  protected_count INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT
);

INSERT INTO logistics_retention_policies
  (organization_id,document_type,retention_years,disposition,legal_basis)
SELECT organization.id,seed.document_type,seed.retention_years,'REVIEW',
  'Plazo inicial configurable; validar con asesoría legal y contractual.'
FROM logistics_organizations organization
CROSS JOIN (VALUES
  ('INSPECTION',5),('EPP_DELIVERY',5),('INVOICE',6),
  ('RECEIPT',5),('WORK_ORDER',5),('OTHER',3)
) AS seed(document_type,retention_years)
ON CONFLICT (organization_id,document_type) DO NOTHING;

CREATE INDEX IF NOT EXISTS logistics_legal_holds_active_idx
  ON logistics_legal_holds (organization_id,status,document_type);
CREATE INDEX IF NOT EXISTS logistics_retention_reviews_date_idx
  ON logistics_retention_reviews (organization_id,reviewed_at DESC);

ALTER TABLE logistics_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_retention_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_retention_policies,logistics_legal_holds,
  logistics_retention_reviews FROM anon,authenticated;
