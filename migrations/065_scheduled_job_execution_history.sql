-- Bitácora inalterable de cada intento de automatización.
CREATE TABLE IF NOT EXISTS logistics_scheduled_job_events (
  id BIGSERIAL PRIMARY KEY,
  execution_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  scheduled_job_id UUID NOT NULL REFERENCES logistics_scheduled_jobs(id),
  job_code TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('STARTED','SUCCESS','FAILED')),
  initiated_by TEXT REFERENCES inventory_user_profiles(id),
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_detail TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id,event_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS logistics_scheduled_job_events_terminal_uq
  ON logistics_scheduled_job_events (execution_id)
  WHERE event_type IN ('SUCCESS','FAILED');
CREATE INDEX IF NOT EXISTS logistics_scheduled_job_events_history_idx
  ON logistics_scheduled_job_events (organization_id,job_code,occurred_at DESC);

CREATE OR REPLACE FUNCTION logistics_scheduled_job_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'El historial de automatizaciones es inalterable';
END $$;

DROP TRIGGER IF EXISTS logistics_scheduled_job_events_no_change
  ON logistics_scheduled_job_events;
CREATE TRIGGER logistics_scheduled_job_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_scheduled_job_events
  FOR EACH ROW EXECUTE FUNCTION logistics_scheduled_job_events_immutable();

ALTER TABLE logistics_scheduled_job_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_scheduled_job_events FROM anon,authenticated;

COMMENT ON TABLE logistics_scheduled_job_events IS
  'Eventos append-only de inicio y término de automatizaciones, para auditoría y diagnóstico.';
