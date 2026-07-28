-- Planificación diaria de conteos cíclicos según clasificación ABC/XYZ.
ALTER TABLE logistics_scheduled_jobs
  DROP CONSTRAINT IF EXISTS logistics_scheduled_jobs_job_code_check;
ALTER TABLE logistics_scheduled_jobs
  ADD CONSTRAINT logistics_scheduled_jobs_job_code_check
  CHECK (job_code IN (
    'KPI_DAILY_SNAPSHOT',
    'REPLENISHMENT_DAILY_REVIEW',
    'CYCLE_COUNT_DAILY_REVIEW'
  ));

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,next_run_at)
SELECT organization.id,'CYCLE_COUNT_DAILY_REVIEW',TRUE,'America/Santiago',9,90,NOW()
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;
