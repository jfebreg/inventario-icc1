-- Planificación de reposición y solicitudes de compra.
CREATE TABLE IF NOT EXISTS logistics_replenishment_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  preferred_supplier_id UUID REFERENCES logistics_suppliers(id),
  minimum_stock NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  reorder_point NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  maximum_stock NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (maximum_stock >= reorder_point),
  safety_stock NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, item_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS logistics_purchase_requisitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  requisition_number TEXT NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  preferred_supplier_id UUID REFERENCES logistics_suppliers(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  requested_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  ordered_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, requisition_number)
);

CREATE TABLE IF NOT EXISTS logistics_purchase_requisition_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id UUID NOT NULL REFERENCES logistics_purchase_requisitions(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  quantity_requested NUMERIC(18,4) NOT NULL CHECK (quantity_requested > 0),
  quantity_received NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (quantity_received >= 0 AND quantity_received <= quantity_requested),
  unit_of_measure TEXT NOT NULL DEFAULT 'UN',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requisition_id, item_id)
);

ALTER TABLE logistics_inbound_receipts
  ADD COLUMN IF NOT EXISTS requisition_id UUID REFERENCES logistics_purchase_requisitions(id);

CREATE INDEX IF NOT EXISTS logistics_replenishment_lookup_idx
  ON logistics_replenishment_policies (organization_id, warehouse_id, active);
CREATE INDEX IF NOT EXISTS logistics_purchase_requisitions_status_idx
  ON logistics_purchase_requisitions (organization_id, warehouse_id, status, created_at DESC);

ALTER TABLE logistics_replenishment_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_purchase_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_purchase_requisition_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_replenishment_policies, logistics_purchase_requisitions,
  logistics_purchase_requisition_lines FROM anon, authenticated;
