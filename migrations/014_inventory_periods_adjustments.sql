-- Cierre mensual y ajustes de inventario con segregación de funciones.
CREATE TABLE IF NOT EXISTS logistics_inventory_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  period_code TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','CLOSING','CLOSED')),
  opened_by TEXT REFERENCES inventory_user_profiles(id),
  closed_by TEXT REFERENCES inventory_user_profiles(id),
  closed_at TIMESTAMPTZ,
  closing_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, period_code),
  UNIQUE (organization_id, starts_on, ends_on),
  CHECK (starts_on <= ends_on)
);

CREATE TABLE IF NOT EXISTS logistics_inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  adjustment_number TEXT NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('COUNT_VARIANCE','DAMAGE','LOSS','FOUND','EXPIRY','DATA_CORRECTION','OTHER')),
  quantity_delta NUMERIC(18,4) NOT NULL CHECK (quantity_delta <> 0),
  system_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_value_delta NUMERIC(20,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  requested_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  posted_by TEXT REFERENCES inventory_user_profiles(id),
  movement_id UUID REFERENCES logistics_stock_movements(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  notes TEXT NOT NULL,
  approval_notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, adjustment_number),
  CHECK (asset_unit_id IS NULL OR ABS(quantity_delta) = 1)
);

CREATE INDEX IF NOT EXISTS logistics_inventory_period_status_idx
  ON logistics_inventory_periods (organization_id, status, starts_on DESC);
CREATE INDEX IF NOT EXISTS logistics_inventory_adjustment_status_idx
  ON logistics_inventory_adjustments (organization_id, warehouse_id, status, requested_at DESC);

ALTER TABLE logistics_inventory_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_inventory_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_inventory_periods, logistics_inventory_adjustments FROM anon, authenticated;
