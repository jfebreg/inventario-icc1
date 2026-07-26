-- Órdenes de compra, facturas y conciliación de tres vías.
CREATE TABLE IF NOT EXISTS logistics_procurement_settings (
  organization_id UUID PRIMARY KEY REFERENCES logistics_organizations(id),
  price_tolerance_percent NUMERIC(8,4) NOT NULL DEFAULT 2 CHECK (price_tolerance_percent >= 0),
  quantity_tolerance_percent NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (quantity_tolerance_percent >= 0),
  amount_tolerance NUMERIC(18,4) NOT NULL DEFAULT 1 CHECK (amount_tolerance >= 0),
  require_purchase_order BOOLEAN NOT NULL DEFAULT TRUE,
  require_receipt BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  purchase_order_number TEXT NOT NULL,
  requisition_id UUID REFERENCES logistics_purchase_requisitions(id),
  supplier_id UUID NOT NULL REFERENCES logistics_suppliers(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED')),
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_date DATE,
  payment_terms TEXT,
  requested_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  sent_by TEXT REFERENCES inventory_user_profiles(id),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, purchase_order_number)
);

CREATE TABLE IF NOT EXISTS logistics_purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES logistics_purchase_orders(id) ON DELETE CASCADE,
  requisition_line_id UUID REFERENCES logistics_purchase_requisition_lines(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  quantity_ordered NUMERIC(18,4) NOT NULL CHECK (quantity_ordered > 0),
  quantity_received NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 19 CHECK (tax_rate >= 0),
  line_subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (line_subtotal >= 0),
  line_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (purchase_order_id, item_id),
  CHECK (quantity_received <= quantity_ordered * 1.25)
);

CREATE TABLE IF NOT EXISTS logistics_supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  supplier_id UUID NOT NULL REFERENCES logistics_suppliers(id),
  purchase_order_id UUID NOT NULL REFERENCES logistics_purchase_orders(id),
  invoice_number TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CLP' CHECK (currency IN ('CLP','USD','EUR','UF')),
  subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING_MATCH'
    CHECK (status IN ('PENDING_MATCH','MATCHED','EXCEPTION','APPROVED','REJECTED','PAID')),
  variance_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
  exception_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  registered_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, supplier_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS logistics_supplier_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES logistics_supplier_invoices(id) ON DELETE CASCADE,
  purchase_order_line_id UUID NOT NULL REFERENCES logistics_purchase_order_lines(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  quantity_invoiced NUMERIC(18,4) NOT NULL CHECK (quantity_invoiced > 0),
  unit_cost NUMERIC(18,4) NOT NULL CHECK (unit_cost >= 0),
  tax_rate NUMERIC(8,4) NOT NULL DEFAULT 19 CHECK (tax_rate >= 0),
  line_subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (line_subtotal >= 0),
  line_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  match_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (match_status IN ('PENDING','MATCHED','EXCEPTION')),
  exception_details JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (invoice_id, purchase_order_line_id)
);

ALTER TABLE logistics_inbound_receipts
  ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES logistics_purchase_orders(id);
ALTER TABLE logistics_inbound_receipt_lines
  ADD COLUMN IF NOT EXISTS purchase_order_line_id UUID REFERENCES logistics_purchase_order_lines(id);

CREATE INDEX IF NOT EXISTS logistics_purchase_orders_status_idx
  ON logistics_purchase_orders (organization_id, warehouse_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS logistics_purchase_orders_requisition_idx
  ON logistics_purchase_orders (requisition_id)
  WHERE requisition_id IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS logistics_supplier_invoices_status_idx
  ON logistics_supplier_invoices (organization_id, status, invoice_date DESC);

ALTER TABLE logistics_procurement_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_supplier_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_supplier_invoice_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_procurement_settings, logistics_purchase_orders,
  logistics_purchase_order_lines, logistics_supplier_invoices,
  logistics_supplier_invoice_lines FROM anon, authenticated;
