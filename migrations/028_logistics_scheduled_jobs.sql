-- Ejecuciones operativas programadas, seguras para múltiples instancias.
CREATE TABLE IF NOT EXISTS logistics_scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  job_code TEXT NOT NULL CHECK (job_code IN ('KPI_DAILY_SNAPSHOT')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  timezone_name TEXT NOT NULL DEFAULT 'America/Santiago',
  local_hour INTEGER NOT NULL DEFAULT 7 CHECK (local_hour BETWEEN 0 AND 23),
  period_days INTEGER NOT NULL DEFAULT 90 CHECK (period_days BETWEEN 1 AND 730),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (last_status IN ('PENDING','RUNNING','SUCCESS','FAILED')),
  last_error TEXT,
  last_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,job_code)
);

CREATE INDEX IF NOT EXISTS logistics_scheduled_jobs_due_idx
  ON logistics_scheduled_jobs (enabled,next_run_at)
  WHERE enabled=TRUE;

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,next_run_at)
SELECT organization.id,'KPI_DAILY_SNAPSHOT',TRUE,'America/Santiago',7,90,NOW()
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;

ALTER TABLE logistics_scheduled_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_scheduled_jobs FROM anon, authenticated;
