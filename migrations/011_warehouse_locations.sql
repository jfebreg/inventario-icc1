-- Direccionamiento de bodega, capacidad y reglas de ubicación.
ALTER TABLE logistics_locations
  ADD COLUMN IF NOT EXISTS zone_code TEXT,
  ADD COLUMN IF NOT EXISTS aisle_code TEXT,
  ADD COLUMN IF NOT EXISTS rack_code TEXT,
  ADD COLUMN IF NOT EXISTS level_code TEXT,
  ADD COLUMN IF NOT EXISTS position_code TEXT,
  ADD COLUMN IF NOT EXISTS capacity_quantity NUMERIC(18,4)
    CHECK (capacity_quantity IS NULL OR capacity_quantity > 0),
  ADD COLUMN IF NOT EXISTS max_weight_kg NUMERIC(18,4)
    CHECK (max_weight_kg IS NULL OR max_weight_kg > 0),
  ADD COLUMN IF NOT EXISTS max_volume_m3 NUMERIC(18,4)
    CHECK (max_volume_m3 IS NULL OR max_volume_m3 > 0),
  ADD COLUMN IF NOT EXISTS picking_sequence INTEGER NOT NULL DEFAULT 1000
    CHECK (picking_sequence >= 0),
  ADD COLUMN IF NOT EXISTS operational_status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (operational_status IN ('AVAILABLE','BLOCKED','COUNTING','MAINTENANCE')),
  ADD COLUMN IF NOT EXISTS allows_mixed_items BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allows_mixed_lots BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS logistics_item_location_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  minimum_quantity NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0),
  maximum_quantity NUMERIC(18,4) CHECK (maximum_quantity IS NULL OR maximum_quantity > 0),
  is_pick_face BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,item_id,location_id)
);

CREATE INDEX IF NOT EXISTS logistics_locations_directed_idx
  ON logistics_locations (warehouse_id,location_type,operational_status,picking_sequence)
  WHERE active=TRUE;
CREATE INDEX IF NOT EXISTS logistics_item_location_rules_lookup_idx
  ON logistics_item_location_rules (organization_id,item_id,active,priority);

UPDATE logistics_locations
SET operational_status='AVAILABLE',
    picking_sequence=CASE location_type
      WHEN 'RECEIVING' THEN 10 WHEN 'QUARANTINE' THEN 20
      WHEN 'STORAGE' THEN 100 WHEN 'DISPATCH' THEN 900 ELSE 1000 END
WHERE operational_status IS NULL OR picking_sequence=1000;

ALTER TABLE logistics_item_location_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_item_location_rules FROM anon, authenticated;
