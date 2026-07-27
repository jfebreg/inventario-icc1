-- Catálogo de compra por proveedor y artículo.
CREATE TABLE IF NOT EXISTS logistics_supplier_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  supplier_id UUID NOT NULL REFERENCES logistics_suppliers(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  item_uom_id UUID REFERENCES logistics_item_uoms(id),
  supplier_item_code TEXT,
  manufacturer_part_number TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  minimum_order_quantity NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (minimum_order_quantity > 0),
  order_multiple NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (order_multiple > 0),
  last_unit_price NUMERIC(18,4) CHECK (last_unit_price IS NULL OR last_unit_price >= 0),
  currency TEXT NOT NULL DEFAULT 'CLP',
  preferred BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from DATE,
  valid_until DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  UNIQUE (supplier_id, item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_supplier_items_code_idx
  ON logistics_supplier_items (supplier_id, UPPER(supplier_item_code))
  WHERE supplier_item_code IS NOT NULL AND supplier_item_code <> '' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS logistics_supplier_items_preferred_idx
  ON logistics_supplier_items (item_id)
  WHERE preferred AND active;
CREATE INDEX IF NOT EXISTS logistics_supplier_items_item_idx
  ON logistics_supplier_items (organization_id,item_id,active,preferred DESC);
CREATE INDEX IF NOT EXISTS logistics_supplier_items_supplier_idx
  ON logistics_supplier_items (supplier_id,active,supplier_item_code);

ALTER TABLE logistics_supplier_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_supplier_items FROM anon, authenticated;
