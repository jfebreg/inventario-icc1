-- Clasificación ABC/XYZ y política de conteo físico.
CREATE TABLE IF NOT EXISTS logistics_classification_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  abc_class TEXT NOT NULL CHECK (abc_class IN ('A','B','C')),
  count_interval_days INTEGER NOT NULL CHECK (count_interval_days > 0),
  tolerance_percent NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tolerance_percent >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,abc_class)
);

CREATE TABLE IF NOT EXISTS logistics_inventory_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  abc_class TEXT NOT NULL CHECK (abc_class IN ('A','B','C')),
  xyz_class TEXT NOT NULL CHECK (xyz_class IN ('X','Y','Z')),
  analysis_months INTEGER NOT NULL DEFAULT 12 CHECK (analysis_months BETWEEN 3 AND 36),
  consumption_quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
  consumption_value NUMERIC(18,4) NOT NULL DEFAULT 0,
  monthly_average NUMERIC(18,6) NOT NULL DEFAULT 0,
  demand_stddev NUMERIC(18,6) NOT NULL DEFAULT 0,
  coefficient_variation NUMERIC(18,6),
  recommended_count_interval_days INTEGER NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id,item_id)
);

INSERT INTO logistics_classification_policies
  (organization_id,abc_class,count_interval_days,tolerance_percent)
SELECT organization.id,seed.abc_class,seed.count_interval_days,seed.tolerance_percent
FROM logistics_organizations organization
CROSS JOIN (VALUES
  ('A',30,2.0000),
  ('B',90,5.0000),
  ('C',180,10.0000)
) AS seed(abc_class,count_interval_days,tolerance_percent)
ON CONFLICT (organization_id,abc_class) DO NOTHING;

CREATE INDEX IF NOT EXISTS logistics_inventory_classifications_priority_idx
  ON logistics_inventory_classifications
  (organization_id,abc_class,xyz_class,calculated_at DESC);

ALTER TABLE logistics_classification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_inventory_classifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_classification_policies,
  logistics_inventory_classifications FROM anon, authenticated;
