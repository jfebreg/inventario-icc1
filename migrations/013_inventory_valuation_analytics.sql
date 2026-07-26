-- Valorización de inventario, costo promedio móvil y trazabilidad de costos.
ALTER TABLE logistics_items
  ADD COLUMN IF NOT EXISTS standard_cost NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (standard_cost >= 0),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CLP'
    CHECK (currency IN ('CLP','USD','EUR','UF')),
  ADD COLUMN IF NOT EXISTS valuation_method TEXT NOT NULL DEFAULT 'MOVING_AVERAGE'
    CHECK (valuation_method IN ('MOVING_AVERAGE','STANDARD'));

ALTER TABLE logistics_stock_movements
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS total_value NUMERIC(20,4) NOT NULL DEFAULT 0
    CHECK (total_value >= 0),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CLP'
    CHECK (currency IN ('CLP','USD','EUR','UF'));

ALTER TABLE logistics_stock_ledger
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS total_value NUMERIC(20,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CLP'
    CHECK (currency IN ('CLP','USD','EUR','UF'));

ALTER TABLE logistics_inbound_receipt_lines
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (unit_cost >= 0),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'CLP'
    CHECK (currency IN ('CLP','USD','EUR','UF'));

CREATE TABLE IF NOT EXISTS logistics_item_cost_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  source_type TEXT NOT NULL,
  source_id TEXT,
  previous_cost NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (previous_cost >= 0),
  new_cost NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (new_cost >= 0),
  received_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  purchase_unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (purchase_unit_cost >= 0),
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS logistics_item_cost_history_lookup_idx
  ON logistics_item_cost_history (organization_id, item_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS logistics_stock_ledger_consumption_idx
  ON logistics_stock_ledger (organization_id, item_id, occurred_at DESC)
  WHERE quantity < 0;

ALTER TABLE logistics_item_cost_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_item_cost_history FROM anon, authenticated;
