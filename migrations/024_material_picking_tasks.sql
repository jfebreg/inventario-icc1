-- Tareas de preparación física para solicitudes internas.
CREATE TABLE IF NOT EXISTS logistics_pick_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  request_id UUID NOT NULL REFERENCES logistics_material_requests(id),
  reservation_id UUID NOT NULL REFERENCES logistics_stock_reservations(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  picking_sequence INTEGER NOT NULL DEFAULT 0,
  quantity_required NUMERIC(18,4) NOT NULL CHECK (quantity_required > 0),
  quantity_picked NUMERIC(18,4) NOT NULL DEFAULT 0
    CHECK (quantity_picked >= 0 AND quantity_picked <= quantity_required),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','PICKED','EXCEPTION','CANCELLED')),
  assigned_to TEXT REFERENCES inventory_user_profiles(id),
  picked_by TEXT REFERENCES inventory_user_profiles(id),
  started_at TIMESTAMPTZ,
  picked_at TIMESTAMPTZ,
  scanned_location TEXT,
  scanned_item TEXT,
  discrepancy_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reservation_id)
);

CREATE INDEX IF NOT EXISTS logistics_pick_tasks_route_idx
  ON logistics_pick_tasks
  (organization_id,warehouse_id,status,picking_sequence,created_at);
CREATE INDEX IF NOT EXISTS logistics_pick_tasks_request_idx
  ON logistics_pick_tasks (request_id,status,picking_sequence);

INSERT INTO logistics_pick_tasks
  (organization_id,request_id,reservation_id,warehouse_id,location_id,item_id,
   asset_unit_id,lot_id,picking_sequence,quantity_required,status)
SELECT reservation.organization_id,reservation.request_id,reservation.id,
  location.warehouse_id,reservation.location_id,reservation.item_id,
  reservation.asset_unit_id,reservation.lot_id,location.picking_sequence,
  reservation.quantity,'OPEN'
FROM logistics_stock_reservations reservation
JOIN logistics_material_requests request ON request.id=reservation.request_id
JOIN logistics_locations location ON location.id=reservation.location_id
WHERE reservation.status='ACTIVE' AND request.status='PICKING'
ON CONFLICT (reservation_id) DO NOTHING;

ALTER TABLE logistics_pick_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_pick_tasks FROM anon, authenticated;
