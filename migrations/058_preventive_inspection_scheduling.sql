-- Programación preventiva de inspecciones por unidad serializada.
CREATE TABLE IF NOT EXISTS logistics_asset_inspection_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  asset_unit_id UUID NOT NULL REFERENCES logistics_asset_units(id),
  interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
  warning_days INTEGER NOT NULL DEFAULT 7 CHECK (warning_days BETWEEN 0 AND 365),
  grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 90),
  initial_due_at TIMESTAMPTZ NOT NULL,
  last_completed_at TIMESTAMPTZ,
  next_due_at TIMESTAMPTZ NOT NULL,
  assigned_inspector_profile_id TEXT REFERENCES inventory_user_profiles(id),
  assigned_reviewer_profile_id TEXT REFERENCES inventory_user_profiles(id),
  block_on_overdue BOOLEAN NOT NULL DEFAULT TRUE,
  blocked_at TIMESTAMPTZ,
  block_released_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_by TEXT REFERENCES inventory_user_profiles(id),
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,asset_unit_id)
);

CREATE INDEX IF NOT EXISTS logistics_asset_inspection_plans_due_idx
  ON logistics_asset_inspection_plans (organization_id,next_due_at)
  WHERE active=TRUE;

CREATE TABLE IF NOT EXISTS logistics_asset_inspection_plan_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  plan_id UUID NOT NULL REFERENCES logistics_asset_inspection_plans(id),
  event_type TEXT NOT NULL,
  actor_profile_id TEXT REFERENCES inventory_user_profiles(id),
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_reject_inspection_plan_event_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El historial del plan de inspección es inalterable';
END $$;

DROP TRIGGER IF EXISTS logistics_inspection_plan_events_no_change
  ON logistics_asset_inspection_plan_events;
CREATE TRIGGER logistics_inspection_plan_events_no_change
BEFORE UPDATE OR DELETE ON logistics_asset_inspection_plan_events
FOR EACH ROW EXECUTE FUNCTION logistics_reject_inspection_plan_event_change();

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
    'INSPECTION_DAILY_REVIEW'
  ));

INSERT INTO logistics_scheduled_jobs
  (organization_id,job_code,enabled,timezone_name,local_hour,period_days,
   schedule_interval_days,batch_limit,next_run_at)
SELECT organization.id,'INSPECTION_DAILY_REVIEW',TRUE,
  'America/Santiago',6,90,1,100,NOW()
FROM logistics_organizations organization
ON CONFLICT (organization_id,job_code) DO NOTHING;

ALTER TABLE logistics_asset_inspection_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_asset_inspection_plan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_asset_inspection_plans FROM anon, authenticated;
REVOKE ALL ON logistics_asset_inspection_plan_events FROM anon, authenticated;
