-- Registro canónico de SKU, GTIN/EAN/UPC y códigos de presentación.
CREATE TABLE IF NOT EXISTS logistics_item_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  item_uom_id UUID REFERENCES logistics_item_uoms(id),
  identifier_type TEXT NOT NULL
    CHECK (identifier_type IN ('SKU','GTIN','EAN','UPC','INTERNAL_BARCODE')),
  identifier_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_item_identifiers_value_idx
  ON logistics_item_identifiers (organization_id,normalized_value)
  WHERE active=TRUE;
CREATE INDEX IF NOT EXISTS logistics_item_identifiers_item_idx
  ON logistics_item_identifiers (item_id,active,identifier_type);

INSERT INTO logistics_item_identifiers
  (organization_id,item_id,identifier_type,identifier_value,normalized_value,is_primary)
SELECT item.organization_id,item.id,'SKU',item.sku,
  UPPER(REGEXP_REPLACE(item.sku,'\s+','','g')),TRUE
FROM logistics_items item
WHERE item.active=TRUE
ON CONFLICT DO NOTHING;

INSERT INTO logistics_item_identifiers
  (organization_id,item_id,identifier_type,identifier_value,normalized_value,is_primary)
SELECT item.organization_id,item.id,
  CASE LENGTH(REGEXP_REPLACE(item.gtin,'\D','','g'))
    WHEN 12 THEN 'UPC' WHEN 13 THEN 'EAN' ELSE 'GTIN' END,
  item.gtin,REGEXP_REPLACE(item.gtin,'\D','','g'),FALSE
FROM logistics_items item
WHERE item.active=TRUE AND COALESCE(BTRIM(item.gtin),'')<>''
ON CONFLICT DO NOTHING;

INSERT INTO logistics_item_identifiers
  (organization_id,item_id,item_uom_id,identifier_type,identifier_value,
   normalized_value,is_primary,metadata)
SELECT presentation.organization_id,presentation.item_id,presentation.id,
  CASE LENGTH(REGEXP_REPLACE(presentation.barcode,'\D','','g'))
    WHEN 8 THEN 'EAN' WHEN 12 THEN 'UPC' WHEN 13 THEN 'EAN'
    WHEN 14 THEN 'GTIN' ELSE 'INTERNAL_BARCODE' END,
  presentation.barcode,UPPER(REGEXP_REPLACE(presentation.barcode,'\s+','','g')),
  FALSE,jsonb_build_object('packageLevel',presentation.package_level)
FROM logistics_item_uoms presentation
WHERE presentation.active=TRUE AND COALESCE(BTRIM(presentation.barcode),'')<>''
ON CONFLICT DO NOTHING;

ALTER TABLE logistics_item_identifiers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_item_identifiers FROM anon, authenticated;
