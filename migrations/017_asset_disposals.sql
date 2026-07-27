-- Bajas de activos con segregación de funciones y retiro sin pérdida de historial.
CREATE TABLE IF NOT EXISTS logistics_asset_disposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  disposal_number TEXT NOT NULL,
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  status TEXT NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','POSTED','CANCELLED')),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('SCRAPPED','SOLD','LOST','STOLEN','DONATED','OBSOLETE','DAMAGED','OTHER')),
  requested_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  rejected_by TEXT REFERENCES inventory_user_profiles(id),
  posted_by TEXT REFERENCES inventory_user_profiles(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  effective_date DATE NOT NULL DEFAULT CURRENT_DATE,
  proceeds_amount NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (proceeds_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  notes TEXT NOT NULL,
  approval_notes TEXT,
  movement_id UUID REFERENCES logistics_stock_movements(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, disposal_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_asset_disposals_open_unit_idx
  ON logistics_asset_disposals (asset_unit_id)
  WHERE status IN ('SUBMITTED','APPROVED');
CREATE INDEX IF NOT EXISTS logistics_asset_disposals_status_idx
  ON logistics_asset_disposals (organization_id, warehouse_id, status, requested_at DESC);

ALTER TABLE logistics_asset_disposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_asset_disposals FROM anon, authenticated;
