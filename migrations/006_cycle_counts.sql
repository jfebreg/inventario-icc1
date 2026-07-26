CREATE TABLE IF NOT EXISTS logistics_cycle_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  count_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','IN_PROGRESS','SUBMITTED','APPROVED','POSTED','CANCELLED')),
  blind_count BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  submitted_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  posted_by TEXT REFERENCES inventory_user_profiles(id),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, count_number)
);

CREATE TABLE IF NOT EXISTS logistics_cycle_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_id UUID NOT NULL REFERENCES logistics_cycle_counts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  lot_id UUID REFERENCES logistics_lots(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  expected_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  counted_quantity NUMERIC(18,4) CHECK (counted_quantity >= 0),
  posted_movement_id UUID REFERENCES logistics_stock_movements(id),
  counted_by TEXT REFERENCES inventory_user_profiles(id),
  counted_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_cycle_count_line_identity_idx
  ON logistics_cycle_count_lines (
    count_id,
    item_id,
    COALESCE(lot_id,'00000000-0000-0000-0000-000000000000'::uuid),
    location_id
  );

CREATE INDEX IF NOT EXISTS logistics_cycle_counts_warehouse_status_idx
  ON logistics_cycle_counts (organization_id,warehouse_id,status,created_at DESC);

ALTER TABLE logistics_cycle_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_cycle_count_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_cycle_counts FROM anon, authenticated;
REVOKE ALL ON logistics_cycle_count_lines FROM anon, authenticated;
