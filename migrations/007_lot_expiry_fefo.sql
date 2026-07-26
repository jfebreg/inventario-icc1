-- Trazabilidad por lote, vencimiento y despacho FEFO.
ALTER TABLE logistics_custody_assignments
  ADD COLUMN IF NOT EXISTS lot_id UUID REFERENCES logistics_lots(id);

CREATE INDEX IF NOT EXISTS logistics_lots_expiry_idx
  ON logistics_lots (organization_id, expires_at, item_id)
  WHERE status IN ('ACTIVE', 'QUARANTINE');

CREATE INDEX IF NOT EXISTS logistics_stock_balances_lot_location_idx
  ON logistics_stock_balances (organization_id, item_id, lot_id, location_id)
  WHERE quantity > 0 AND lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS logistics_custody_lot_idx
  ON logistics_custody_assignments (organization_id, lot_id, created_at)
  WHERE lot_id IS NOT NULL;

ALTER TABLE logistics_custody_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_lots, logistics_custody_assignments FROM anon, authenticated;
