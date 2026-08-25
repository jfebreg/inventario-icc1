-- Verificación semanal específica de los PDF finales de inspección.
ALTER TABLE logistics_scheduled_jobs
  DROP CONSTRAINT IF EXISTS logistics_scheduled_jobs_job_code_check;
ALTER TABLE logistics_scheduled_jobs
  ADD CONSTRAINT logistics_scheduled_jobs_job_code_check
  CHECK (job_code IN (
    'KPI_DAILY_SNAPSHOT',
    'REPLENISHMENT_DAILY_REVIEW',
    'CYCLE_COUNT_DAILY_REVIEW',
    'DATA_QUALITY_DAILY_REVIEW',
    'EVIDENCE_WEEKLY_VERIFICATION',
    'INSPECTION_DAILY_REVIEW',
    'INSPECTION_REPORT_WEEKLY_VERIFICATION'
  ));

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,
   schedule_interval_days,batch_limit,next_run_at)
SELECT organization.id,'INSPECTION_REPORT_WEEKLY_VERIFICATION',TRUE,
  'America/Santiago',4,90,7,25,
  ((((NOW() AT TIME ZONE 'America/Santiago')::date+1)+INTERVAL '4 hours')
    AT TIME ZONE 'America/Santiago')
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;
