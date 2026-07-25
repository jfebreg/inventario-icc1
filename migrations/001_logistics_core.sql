CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS logistics_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tax_id TEXT,
  address TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_cost_centers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  legacy_key TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, legacy_key)
);

CREATE TABLE IF NOT EXISTS logistics_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  cost_center_id UUID REFERENCES logistics_cost_centers(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS logistics_warehouses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  site_id UUID REFERENCES logistics_sites(id),
  cost_center_id UUID REFERENCES logistics_cost_centers(id),
  legacy_key TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  warehouse_type TEXT NOT NULL DEFAULT 'PHYSICAL'
    CHECK (warehouse_type IN ('PHYSICAL', 'VIRTUAL', 'TRANSIT', 'SUPPLIER', 'CUSTOMER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, legacy_key)
);

CREATE TABLE IF NOT EXISTS logistics_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  parent_id UUID REFERENCES logistics_locations(id),
  legacy_key TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  location_type TEXT NOT NULL DEFAULT 'STORAGE'
    CHECK (location_type IN ('STORAGE', 'RECEIVING', 'DISPATCH', 'TRANSIT', 'CUSTODY', 'QUARANTINE', 'REPAIR', 'SCRAP', 'SUPPLIER', 'CUSTOMER')),
  barcode TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, legacy_key),
  UNIQUE (organization_id, barcode)
);

CREATE TABLE IF NOT EXISTS logistics_item_families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  legacy_key TEXT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  inspection_template_legacy_key TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, legacy_key)
);

CREATE TABLE IF NOT EXISTS logistics_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  family_id UUID REFERENCES logistics_item_families(id),
  legacy_key TEXT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  item_type TEXT NOT NULL DEFAULT 'ASSET'
    CHECK (item_type IN ('ASSET', 'CONSUMABLE', 'PPE', 'TOOL', 'SPARE_PART')),
  tracking_type TEXT NOT NULL DEFAULT 'SERIAL'
    CHECK (tracking_type IN ('NONE', 'LOT', 'SERIAL')),
  unit_of_measure TEXT NOT NULL DEFAULT 'UN',
  brand TEXT,
  model TEXT,
  gtin TEXT,
  minimum_stock NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (minimum_stock >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, sku),
  UNIQUE (organization_id, legacy_key),
  UNIQUE (organization_id, gtin)
);

CREATE TABLE IF NOT EXISTS logistics_asset_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  legacy_key TEXT,
  unit_code TEXT NOT NULL,
  manufacturer_serial TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'RESERVED', 'IN_TRANSIT', 'IN_CUSTODY', 'BLOCKED', 'REPAIR', 'RETIRED', 'LOST')),
  commissioned_at DATE,
  retired_at DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, unit_code),
  UNIQUE (organization_id, legacy_key),
  UNIQUE (organization_id, manufacturer_serial)
);

CREATE TABLE IF NOT EXISTS logistics_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  lot_number TEXT NOT NULL,
  manufactured_at DATE,
  expires_at DATE,
  supplier_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUARANTINE', 'EXPIRED', 'RECALLED', 'CLOSED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, item_id, lot_number)
);

CREATE TABLE IF NOT EXISTS logistics_stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('OPENING', 'RECEIPT', 'ISSUE', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT', 'CUSTODY_ISSUE', 'CUSTODY_RETURN', 'CONSUMPTION', 'ADJUSTMENT', 'REVERSAL')),
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'QR', 'BARCODE', 'IMPORT', 'AI_CONFIRMED', 'LEGACY_BACKFILL', 'SYSTEM')),
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  reversal_of UUID REFERENCES logistics_stock_movements(id),
  notes TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS logistics_stock_ledger (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  movement_id UUID NOT NULL REFERENCES logistics_stock_movements(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity <> 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (asset_unit_id IS NULL OR ABS(quantity) = 1)
);

CREATE INDEX IF NOT EXISTS logistics_stock_ledger_lookup_idx
  ON logistics_stock_ledger (organization_id, item_id, location_id, asset_unit_id, lot_id, occurred_at);
CREATE INDEX IF NOT EXISTS logistics_stock_ledger_movement_idx
  ON logistics_stock_ledger (movement_id);

CREATE TABLE IF NOT EXISTS logistics_stock_balances (
  balance_key TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  location_id UUID NOT NULL REFERENCES logistics_locations(id),
  quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS logistics_stock_balances_item_idx
  ON logistics_stock_balances (organization_id, item_id, location_id);

CREATE TABLE IF NOT EXISTS logistics_transfer_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  transfer_number TEXT NOT NULL,
  source_warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  destination_warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  transit_location_id UUID REFERENCES logistics_locations(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'RELEASED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  requested_by TEXT REFERENCES inventory_user_profiles(id),
  dispatched_by TEXT REFERENCES inventory_user_profiles(id),
  received_by TEXT REFERENCES inventory_user_profiles(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, transfer_number),
  CHECK (source_warehouse_id <> destination_warehouse_id)
);

CREATE TABLE IF NOT EXISTS logistics_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES logistics_transfer_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  lot_id UUID REFERENCES logistics_lots(id),
  quantity_requested NUMERIC(18,4) NOT NULL CHECK (quantity_requested > 0),
  quantity_dispatched NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_dispatched >= 0),
  quantity_received NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  discrepancy_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (asset_unit_id IS NULL OR quantity_requested = 1),
  CHECK (quantity_dispatched <= quantity_requested),
  CHECK (quantity_received <= quantity_dispatched)
);

CREATE TABLE IF NOT EXISTS logistics_custody_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  item_id UUID NOT NULL REFERENCES logistics_items(id),
  asset_unit_id UUID REFERENCES logistics_asset_units(id),
  worker_id TEXT REFERENCES inventory_worker_enrollments(id),
  warehouse_id UUID NOT NULL REFERENCES logistics_warehouses(id),
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('ASSET_CUSTODY', 'PPE_DELIVERY', 'CONSUMABLE_DELIVERY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'ACCEPTED', 'RETURNED', 'CONSUMED', 'CANCELLED')),
  acceptance_token_hash TEXT,
  accepted_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  issued_by TEXT REFERENCES inventory_user_profiles(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  file_object_id TEXT REFERENCES inventory_file_objects(id),
  document_type TEXT NOT NULL,
  document_number TEXT,
  title TEXT NOT NULL,
  sha256 TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'VOID')),
  created_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_document_links (
  document_id UUID NOT NULL REFERENCES logistics_documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'EVIDENCE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, entity_type, entity_id, relationship)
);

CREATE TABLE IF NOT EXISTS logistics_audit_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  correlation_id TEXT,
  source TEXT NOT NULL DEFAULT 'SYSTEM',
  before_data JSONB,
  after_data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_audit_legacy_event_idx
  ON logistics_audit_events (organization_id, event_type, entity_type, entity_id)
  WHERE source = 'LEGACY_BACKFILL';

CREATE TABLE IF NOT EXISTS logistics_outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS logistics_outbox_pending_idx
  ON logistics_outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS logistics_inspection_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  template_key TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  family_id UUID REFERENCES logistics_item_families(id),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  effective_from DATE,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, template_key, version)
);

CREATE TABLE IF NOT EXISTS logistics_inspection_template_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_version_id UUID NOT NULL REFERENCES logistics_inspection_template_versions(id) ON DELETE CASCADE,
  item_order INTEGER NOT NULL CHECK (item_order > 0),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  response_type TEXT NOT NULL DEFAULT 'COMPLIANCE'
    CHECK (response_type IN ('COMPLIANCE', 'BOOLEAN', 'NUMBER', 'TEXT', 'DATE', 'CHOICE')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  requires_evidence_on_failure BOOLEAN NOT NULL DEFAULT FALSE,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (template_version_id, code),
  UNIQUE (template_version_id, item_order)
);

CREATE TABLE IF NOT EXISTS logistics_inspection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  template_version_id UUID NOT NULL REFERENCES logistics_inspection_template_versions(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CORRECTION_PENDING', 'CLOSED')),
  result TEXT CHECK (result IN ('COMPLIANT', 'NON_COMPLIANT', 'NOT_APPLICABLE')),
  inspector_profile_id TEXT REFERENCES inventory_user_profiles(id),
  approver_profile_id TEXT REFERENCES inventory_user_profiles(id),
  inspected_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_inspection_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES logistics_inspection_runs(id) ON DELETE CASCADE,
  template_item_id UUID NOT NULL REFERENCES logistics_inspection_template_items(id),
  result TEXT,
  value_text TEXT,
  value_number NUMERIC,
  notes TEXT,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (inspection_id, template_item_id)
);

CREATE TABLE IF NOT EXISTS logistics_inspection_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES logistics_inspection_runs(id) ON DELETE CASCADE,
  template_item_id UUID REFERENCES logistics_inspection_template_items(id),
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  corrective_action TEXT,
  due_at TIMESTAMPTZ,
  corrected_at TIMESTAMPTZ,
  verified_by TEXT REFERENCES inventory_user_profiles(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CORRECTED', 'VERIFIED', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_inspection_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id UUID NOT NULL REFERENCES logistics_inspection_runs(id) ON DELETE CASCADE,
  approver_profile_id TEXT REFERENCES inventory_user_profiles(id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED', 'RETURNED')),
  comments TEXT,
  signature_file_id TEXT REFERENCES inventory_file_objects(id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW logistics_stock_on_hand AS
SELECT
  organization_id,
  item_id,
  asset_unit_id,
  lot_id,
  location_id,
  SUM(quantity)::NUMERIC(18,4) AS quantity
FROM logistics_stock_ledger
GROUP BY organization_id, item_id, asset_unit_id, lot_id, location_id
HAVING SUM(quantity) <> 0;

CREATE OR REPLACE VIEW logistics_company_stock AS
SELECT
  l.organization_id,
  l.item_id,
  l.asset_unit_id,
  l.lot_id,
  SUM(l.quantity)::NUMERIC(18,4) AS quantity
FROM logistics_stock_ledger l
JOIN logistics_locations loc ON loc.id = l.location_id
WHERE loc.location_type NOT IN ('SUPPLIER', 'CUSTOMER', 'SCRAP')
GROUP BY l.organization_id, l.item_id, l.asset_unit_id, l.lot_id
HAVING SUM(l.quantity) <> 0;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'logistics_organizations', 'logistics_cost_centers', 'logistics_sites',
    'logistics_warehouses', 'logistics_locations', 'logistics_item_families',
    'logistics_items', 'logistics_asset_units', 'logistics_lots',
    'logistics_stock_movements', 'logistics_stock_ledger', 'logistics_stock_balances',
    'logistics_transfer_orders', 'logistics_transfer_lines', 'logistics_custody_assignments',
    'logistics_documents', 'logistics_document_links', 'logistics_audit_events',
    'logistics_outbox_events', 'logistics_inspection_template_versions',
    'logistics_inspection_template_items', 'logistics_inspection_runs',
    'logistics_inspection_answers', 'logistics_inspection_findings',
    'logistics_inspection_approvals'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', table_name);
  END LOOP;
END $$;
