-- Metas operativas configurables y evaluación de desviaciones.
CREATE TABLE IF NOT EXISTS logistics_kpi_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  metric_code TEXT NOT NULL CHECK (metric_code IN (
    'FILL_RATE','ON_TIME_RATE','PICKING_ACCURACY','INVENTORY_ACCURACY',
    'AVERAGE_CYCLE_HOURS','OVERDUE_OPEN_REQUESTS'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('MINIMUM','MAXIMUM')),
  target_value NUMERIC(18,4) NOT NULL,
  warning_value NUMERIC(18,4) NOT NULL,
  critical_value NUMERIC(18,4) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id,warehouse_id,metric_code)
);

CREATE INDEX IF NOT EXISTS logistics_kpi_targets_scope_idx
  ON logistics_kpi_targets (organization_id,warehouse_id,enabled,metric_code);

INSERT INTO logistics_kpi_targets
  (organization_id,warehouse_id,metric_code,direction,target_value,warning_value,critical_value)
SELECT organization.id,NULL,seed.metric_code,seed.direction,
  seed.target_value,seed.warning_value,seed.critical_value
FROM logistics_organizations organization
CROSS JOIN (VALUES
  ('FILL_RATE','MINIMUM',95,90,80),
  ('ON_TIME_RATE','MINIMUM',90,80,70),
  ('PICKING_ACCURACY','MINIMUM',99,97,95),
  ('INVENTORY_ACCURACY','MINIMUM',97,95,90),
  ('AVERAGE_CYCLE_HOURS','MAXIMUM',24,48,72),
  ('OVERDUE_OPEN_REQUESTS','MAXIMUM',0,1,5)
) AS seed(metric_code,direction,target_value,warning_value,critical_value)
ON CONFLICT (organization_id,warehouse_id,metric_code) DO NOTHING;

ALTER TABLE logistics_kpi_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_kpi_targets FROM anon, authenticated;
