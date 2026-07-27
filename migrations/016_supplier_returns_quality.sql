-- No conformidades de recepción y devolución controlada a proveedor.
CREATE TABLE IF NOT EXISTS logistics_supplier_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  return_number TEXT NOT NULL,
  receipt_id UUID NOT NULL REFERENCES logistics_inbound_receipts(id),
  supplier_id UUID NOT NULL REFERENCES logistics_suppliers(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  status TEXT NOT NULL DEFAULT 'SHIPPED'
    CHECK (status IN ('SHIPPED','DELIVERED','CREDIT_PENDING','CREDITED','CLOSED','CANCELLED')),
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('QUALITY','DAMAGED','WRONG_ITEM','WRONG_QUANTITY','EXPIRED','DOCUMENT','OTHER')),
  document_number TEXT,
  carrier TEXT,
  tracking_number TEXT,
  notes TEXT NOT NULL,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  delivered_by TEXT REFERENCES inventory_user_profiles(id),
  credited_by TEXT REFERENCES inventory_user_profiles(id),
  closed_by TEXT REFERENCES inventory_user_profiles(id),
  shipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  credit_note_number TEXT,
  credit_amount NUMERIC(18,4),
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, return_number),
  UNIQUE (receipt_id)
);

CREATE TABLE IF NOT EXISTS logistics_supplier_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_return_id UUID NOT NULL REFERENCES logistics_supplier_returns(id),
  receipt_line_id UUID NOT NULL REFERENCES logistics_inbound_receipt_lines(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  return_movement_id UUID NOT NULL REFERENCES logistics_stock_movements(id),
  unit_cost NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_return_id, receipt_line_id),
  CHECK (asset_unit_id IS NULL OR quantity = 1)
);

CREATE INDEX IF NOT EXISTS logistics_supplier_returns_status_idx
  ON logistics_supplier_returns (organization_id, warehouse_id, status, shipped_at DESC);
CREATE INDEX IF NOT EXISTS logistics_supplier_return_lines_return_idx
  ON logistics_supplier_return_lines (supplier_return_id);

ALTER TABLE logistics_supplier_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_supplier_return_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_supplier_returns, logistics_supplier_return_lines FROM anon, authenticated;
