-- Historial de indicadores operativos para seguimiento y mejora continua.
CREATE TABLE IF NOT EXISTS logistics_kpi_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  period_days INTEGER NOT NULL DEFAULT 90 CHECK (period_days BETWEEN 1 AND 730),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (organization_id,warehouse_id,period_days,snapshot_date)
);

CREATE INDEX IF NOT EXISTS logistics_kpi_snapshots_history_idx
  ON logistics_kpi_snapshots (organization_id,warehouse_id,snapshot_date DESC);

ALTER TABLE logistics_kpi_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_kpi_snapshots FROM anon, authenticated;
