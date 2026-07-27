-- Despacho y recepción formal de solicitudes entre bodegas.
ALTER TABLE logistics_material_requests
  DROP CONSTRAINT IF EXISTS logistics_material_requests_status_check;
ALTER TABLE logistics_material_requests
  ADD CONSTRAINT logistics_material_requests_status_check
  CHECK (status IN (
    'DRAFT','SUBMITTED','APPROVED','ALLOCATED','PICKING',
    'IN_TRANSIT','RECEIVED','ISSUED','CANCELLED'
  ));

ALTER TABLE logistics_material_requests
  ADD COLUMN IF NOT EXISTS transfer_id UUID REFERENCES logistics_transfer_orders(id),
  ADD COLUMN IF NOT EXISTS received_by TEXT REFERENCES inventory_user_profiles(id),
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receiver_name TEXT,
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS logistics_material_requests_transfer_idx
  ON logistics_material_requests (transfer_id) WHERE transfer_id IS NOT NULL;

ALTER TABLE logistics_transfer_lines
  ADD COLUMN IF NOT EXISTS source_location_id UUID REFERENCES logistics_locations(id),
  ADD COLUMN IF NOT EXISTS request_reservation_id UUID REFERENCES logistics_stock_reservations(id);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_transfer_lines_reservation_idx
  ON logistics_transfer_lines (request_reservation_id)
  WHERE request_reservation_id IS NOT NULL;

ALTER TABLE logistics_material_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_transfer_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_material_requests, logistics_transfer_lines FROM anon, authenticated;
