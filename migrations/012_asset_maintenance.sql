-- Gestión de mantenimiento preventivo y correctivo de activos.
CREATE TABLE IF NOT EXISTS logistics_maintenance_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  name TEXT NOT NULL,
  maintenance_type TEXT NOT NULL DEFAULT 'PREVENTIVE'
    CHECK (maintenance_type IN ('PREVENTIVE','PREDICTIVE','LEGAL')),
  interval_days INTEGER NOT NULL CHECK (interval_days > 0),
  last_completed_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ NOT NULL,
  estimated_duration_hours NUMERIC(10,2) CHECK (estimated_duration_hours IS NULL OR estimated_duration_hours > 0),
  checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,asset_unit_id,name)
);

CREATE TABLE IF NOT EXISTS logistics_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  work_order_number TEXT NOT NULL,
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  maintenance_plan_id UUID REFERENCES logistics_maintenance_plans(id),
  inspection_id UUID REFERENCES logistics_inspection_runs(id),
  finding_id UUID REFERENCES logistics_inspection_findings(id),
  work_type TEXT NOT NULL DEFAULT 'CORRECTIVE'
    CHECK (work_type IN ('PREVENTIVE','PREDICTIVE','CORRECTIVE','INSPECTION')),
  priority TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (priority IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','APPROVED','IN_PROGRESS','WAITING_PARTS','COMPLETED','CANCELLED')),
  title TEXT NOT NULL,
  description TEXT,
  resolution TEXT,
  blocks_operation BOOLEAN NOT NULL DEFAULT TRUE,
  requested_by TEXT REFERENCES inventory_user_profiles(id),
  approved_by TEXT REFERENCES inventory_user_profiles(id),
  assigned_to TEXT REFERENCES inventory_user_profiles(id),
  completed_by TEXT REFERENCES inventory_user_profiles(id),
  planned_start_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  downtime_hours NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (downtime_hours >= 0),
  labor_cost NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (labor_cost >= 0),
  parts_cost NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,work_order_number)
);

CREATE TABLE IF NOT EXISTS logistics_work_order_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id UUID NOT NULL REFERENCES logistics_work_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  quantity_planned NUMERIC(18,4) NOT NULL CHECK (quantity_planned > 0),
  quantity_used NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (quantity_used >= 0 AND quantity_used <= quantity_planned),
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  stock_movement_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id,item_id)
);

CREATE INDEX IF NOT EXISTS logistics_maintenance_plans_due_idx
  ON logistics_maintenance_plans (organization_id,next_due_at)
  WHERE active=TRUE;
CREATE INDEX IF NOT EXISTS logistics_work_orders_asset_idx
  ON logistics_work_orders (organization_id,asset_unit_id,status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS logistics_work_orders_inspection_open_idx
  ON logistics_work_orders (inspection_id)
  WHERE inspection_id IS NOT NULL AND status NOT IN ('COMPLETED','CANCELLED');

ALTER TABLE logistics_maintenance_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_work_order_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_maintenance_plans, logistics_work_orders,
  logistics_work_order_parts FROM anon, authenticated;
