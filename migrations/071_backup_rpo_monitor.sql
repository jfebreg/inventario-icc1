-- Vigilancia diaria del objetivo de punto de recuperación del respaldo canónico.
ALTER TABLE logistics_scheduled_jobs
  DROP CONSTRAINT IF EXISTS logistics_scheduled_jobs_job_code_check;
ALTER TABLE logistics_scheduled_jobs
  ADD CONSTRAINT logistics_scheduled_jobs_job_code_check
  CHECK (job_code IN (
    'KPI_DAILY_SNAPSHOT','REPLENISHMENT_DAILY_REVIEW','CYCLE_COUNT_DAILY_REVIEW',
    'DATA_QUALITY_DAILY_REVIEW','EVIDENCE_WEEKLY_VERIFICATION','INSPECTION_DAILY_REVIEW',
    'INSPECTION_REPORT_WEEKLY_VERIFICATION','BACKUP_RPO_DAILY_CHECK'
  ));

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,next_run_at)
SELECT id,'BACKUP_RPO_DAILY_CHECK',TRUE,'America/Santiago',3,1,
  ((((NOW() AT TIME ZONE 'America/Santiago')::date+1)+INTERVAL '3 hours')
    AT TIME ZONE 'America/Santiago')
FROM logistics_organizations
ON CONFLICT (organization_id,job_code) DO NOTHING;
