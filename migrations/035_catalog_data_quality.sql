-- Gobierno de datos maestros e incidencias corregibles.
CREATE TABLE IF NOT EXISTS logistics_data_quality_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  issue_key TEXT NOT NULL,
  rule_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','RESOLVED','WAIVED')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  item_id UUID REFERENCES logistics_items(id),
  warehouse_id UUID REFERENCES logistics_warehouses(id),
  title TEXT NOT NULL,
  detail TEXT,
  recommendation TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,issue_key)
);

CREATE INDEX IF NOT EXISTS logistics_data_quality_status_idx
  ON logistics_data_quality_issues
  (organization_id,status,severity,last_detected_at DESC);

ALTER TABLE logistics_data_quality_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_data_quality_issues FROM anon, authenticated;

ALTER TABLE logistics_scheduled_jobs
  DROP CONSTRAINT IF EXISTS logistics_scheduled_jobs_job_code_check;
ALTER TABLE logistics_scheduled_jobs
  ADD CONSTRAINT logistics_scheduled_jobs_job_code_check
  CHECK (job_code IN (
    'KPI_DAILY_SNAPSHOT',
    'REPLENISHMENT_DAILY_REVIEW',
    'CYCLE_COUNT_DAILY_REVIEW',
    'DATA_QUALITY_DAILY_REVIEW'
  ));

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,next_run_at)
SELECT organization.id,'DATA_QUALITY_DAILY_REVIEW',TRUE,
  'America/Santiago',10,90,NOW()
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;
