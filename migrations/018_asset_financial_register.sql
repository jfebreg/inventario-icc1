-- Registro financiero auxiliar por unidad serializada.
CREATE TABLE IF NOT EXISTS logistics_asset_financials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  acquisition_date DATE NOT NULL,
  acquisition_cost NUMERIC(18,4) NOT NULL CHECK (acquisition_cost >= 0),
  residual_value NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months INTEGER NOT NULL CHECK (useful_life_months > 0),
  depreciation_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE'
    CHECK (depreciation_method IN ('STRAIGHT_LINE')),
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  cost_center_id UUID REFERENCES logistics_cost_centers(id),
  document_number TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (asset_unit_id),
  CHECK (residual_value <= acquisition_cost)
);

CREATE TABLE IF NOT EXISTS logistics_asset_depreciation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  financial_id UUID NOT NULL REFERENCES logistics_asset_financials(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  as_of_date DATE NOT NULL,
  months_depreciated INTEGER NOT NULL CHECK (months_depreciated >= 0),
  monthly_depreciation NUMERIC(18,4) NOT NULL CHECK (monthly_depreciation >= 0),
  period_depreciation NUMERIC(18,4) NOT NULL CHECK (period_depreciation >= 0),
  accumulated_depreciation NUMERIC(18,4) NOT NULL CHECK (accumulated_depreciation >= 0),
  book_value NUMERIC(18,4) NOT NULL CHECK (book_value >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('CLP','USD','EUR','UF')),
  run_by TEXT REFERENCES inventory_user_profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (financial_id, as_of_date)
);

CREATE INDEX IF NOT EXISTS logistics_asset_financials_org_idx
  ON logistics_asset_financials (organization_id, active, acquisition_date);
CREATE INDEX IF NOT EXISTS logistics_asset_depreciation_date_idx
  ON logistics_asset_depreciation_snapshots (organization_id, as_of_date DESC);

ALTER TABLE logistics_asset_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_asset_depreciation_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_asset_financials, logistics_asset_depreciation_snapshots FROM anon, authenticated;
