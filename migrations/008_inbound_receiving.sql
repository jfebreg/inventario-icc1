-- Recepción controlada de compras, proveedores y cuarentena.
CREATE TABLE IF NOT EXISTS logistics_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  code TEXT NOT NULL,
  tax_id TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','BLOCKED','INACTIVE')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_suppliers_tax_id_idx
  ON logistics_suppliers (organization_id, tax_id)
  WHERE tax_id IS NOT NULL AND tax_id <> '';

CREATE TABLE IF NOT EXISTS logistics_inbound_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  receipt_number TEXT NOT NULL,
  supplier_id UUID NOT NULL REFERENCES logistics_suppliers(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  document_type TEXT NOT NULL DEFAULT 'DELIVERY_NOTE'
    CHECK (document_type IN ('PURCHASE_ORDER','INVOICE','DELIVERY_NOTE','OTHER')),
  document_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUARANTINE'
    CHECK (status IN ('QUARANTINE','RELEASED','REJECTED','CANCELLED')),
  received_by TEXT REFERENCES inventory_user_profiles(id),
  released_by TEXT REFERENCES inventory_user_profiles(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, receipt_number),
  UNIQUE (organization_id, supplier_id, document_type, document_number)
);

CREATE TABLE IF NOT EXISTS logistics_inbound_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES logistics_inbound_receipts(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  condition_status TEXT NOT NULL DEFAULT 'QUARANTINE'
    CHECK (condition_status IN ('QUARANTINE','ACCEPTED','REJECTED')),
  receipt_movement_id UUID REFERENCES logistics_stock_movements(id),
  release_movement_id UUID REFERENCES logistics_stock_movements(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (asset_unit_id IS NULL OR quantity = 1)
);

CREATE INDEX IF NOT EXISTS logistics_inbound_receipts_status_idx
  ON logistics_inbound_receipts (organization_id, warehouse_id, status, received_at DESC);
CREATE INDEX IF NOT EXISTS logistics_inbound_lines_receipt_idx
  ON logistics_inbound_receipt_lines (receipt_id);

INSERT INTO logistics_locations
  (organization_id, warehouse_id, legacy_key, code, name, location_type, barcode, active, updated_at)
SELECT warehouse.organization_id, warehouse.id,
  COALESCE(warehouse.legacy_key,warehouse.code) || ':quarantine',
  'LOC-' || warehouse.code || '-QUARANTINE',
  warehouse.name || ' · Cuarentena',
  'QUARANTINE',
  'LOC-' || warehouse.code || '-QUARANTINE',
  TRUE,
  NOW()
FROM logistics_warehouses warehouse
WHERE warehouse.active=TRUE
ON CONFLICT (organization_id, code) DO UPDATE SET
  warehouse_id=EXCLUDED.warehouse_id,name=EXCLUDED.name,location_type='QUARANTINE',
  active=TRUE,updated_at=NOW();

ALTER TABLE logistics_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_inbound_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_inbound_receipt_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_suppliers, logistics_inbound_receipts,
  logistics_inbound_receipt_lines FROM anon, authenticated;
