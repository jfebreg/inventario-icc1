-- Unidades de medida y presentaciones por artículo.
CREATE TABLE IF NOT EXISTS logistics_units_of_measure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  dimension TEXT NOT NULL DEFAULT 'COUNT'
    CHECK (dimension IN ('COUNT','MASS','LENGTH','AREA','VOLUME','OTHER')),
  decimal_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS logistics_item_uoms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  uom_id UUID NOT NULL REFERENCES logistics_units_of_measure(id),
  conversion_to_base NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (conversion_to_base > 0),
  package_level TEXT NOT NULL DEFAULT 'EACH'
    CHECK (package_level IN ('EACH','INNER','CASE','PALLET','BULK')),
  barcode TEXT,
  supplier_code TEXT,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  use_for_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  use_for_issue BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, uom_id, package_level)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_item_uoms_base_idx
  ON logistics_item_uoms (item_id) WHERE is_base AND active;
CREATE UNIQUE INDEX IF NOT EXISTS logistics_item_uoms_barcode_idx
  ON logistics_item_uoms (organization_id, UPPER(barcode))
  WHERE barcode IS NOT NULL AND barcode <> '' AND active;
CREATE INDEX IF NOT EXISTS logistics_item_uoms_item_idx
  ON logistics_item_uoms (item_id, active, package_level);

INSERT INTO logistics_units_of_measure
  (organization_id,code,name,dimension,decimal_allowed)
SELECT organization.id, seed.code, seed.name, seed.dimension, seed.decimal_allowed
FROM logistics_organizations organization
CROSS JOIN (VALUES
  ('UN','Unidad','COUNT',FALSE),
  ('PAR','Par','COUNT',FALSE),
  ('PAQ','Paquete','COUNT',FALSE),
  ('CAJA','Caja','COUNT',FALSE),
  ('KG','Kilogramo','MASS',TRUE),
  ('G','Gramo','MASS',TRUE),
  ('L','Litro','VOLUME',TRUE),
  ('ML','Mililitro','VOLUME',TRUE),
  ('M','Metro','LENGTH',TRUE),
  ('CM','Centímetro','LENGTH',TRUE),
  ('M2','Metro cuadrado','AREA',TRUE),
  ('M3','Metro cúbico','VOLUME',TRUE)
) AS seed(code,name,dimension,decimal_allowed)
ON CONFLICT (organization_id,code) DO NOTHING;

INSERT INTO logistics_units_of_measure
  (organization_id,code,name,dimension,decimal_allowed)
SELECT DISTINCT item.organization_id, UPPER(item.unit_of_measure),
  UPPER(item.unit_of_measure), 'OTHER', TRUE
FROM logistics_items item
WHERE COALESCE(item.unit_of_measure,'') <> ''
ON CONFLICT (organization_id,code) DO NOTHING;

INSERT INTO logistics_item_uoms
  (organization_id,item_id,uom_id,conversion_to_base,package_level,is_base,use_for_purchase,use_for_issue)
SELECT item.organization_id,item.id,uom.id,1,'EACH',TRUE,TRUE,TRUE
FROM logistics_items item
JOIN logistics_units_of_measure uom
  ON uom.organization_id=item.organization_id
 AND uom.code=UPPER(item.unit_of_measure)
ON CONFLICT (item_id,uom_id,package_level) DO NOTHING;

ALTER TABLE logistics_units_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_item_uoms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_units_of_measure, logistics_item_uoms FROM anon, authenticated;
