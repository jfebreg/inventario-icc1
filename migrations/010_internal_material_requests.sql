-- Solicitudes internas y reservas de stock.
CREATE TABLE IF NOT EXISTS logistics_material_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  request_number TEXT NOT NULL,
  requesting_warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  fulfillment_warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','ALLOCATED','PICKING','ISSUED','CANCELLED')),
  requested_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  prepared_by TEXT REFERENCES inventory_user_profiles(id),
  issued_by TEXT REFERENCES inventory_user_profiles(id),
  purpose TEXT,
  needed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  allocated_at TIMESTAMPTZ,
  picking_at TIMESTAMPTZ,
  issued_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, request_number)
);

CREATE TABLE IF NOT EXISTS logistics_material_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES logistics_material_requests(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  quantity_requested NUMERIC(18,4) NOT NULL CHECK (quantity_requested > 0),
  quantity_reserved NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (quantity_reserved >= 0 AND quantity_reserved <= quantity_requested),
  quantity_issued NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (quantity_issued >= 0 AND quantity_issued <= quantity_requested),
  unit_of_measure TEXT NOT NULL DEFAULT 'UN',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, item_id)
);

CREATE TABLE IF NOT EXISTS logistics_stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  request_id UUID NOT NULL REFERENCES logistics_material_requests(id),
  request_line_id UUID NOT NULL REFERENCES logistics_material_request_lines(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ISSUED','RELEASED')),
  reserved_by TEXT REFERENCES inventory_user_profiles(id),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS logistics_material_requests_status_idx
  ON logistics_material_requests (organization_id, fulfillment_warehouse_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS logistics_stock_reservations_availability_idx
  ON logistics_stock_reservations (organization_id, item_id, location_id, lot_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS logistics_stock_reservations_active_unit_idx
  ON logistics_stock_reservations (asset_unit_id)
  WHERE asset_unit_id IS NOT NULL AND status='ACTIVE';

ALTER TABLE logistics_material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_material_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_stock_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_material_requests, logistics_material_request_lines,
  logistics_stock_reservations FROM anon, authenticated;
