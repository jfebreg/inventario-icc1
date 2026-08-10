-- Detección y revisión de accesos anómalos a evidencias documentales.
CREATE TABLE IF NOT EXISTS logistics_file_access_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ended_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL CHECK (access_count > 0),
  sensitive_access_count INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive_access_count >= 0),
  distinct_file_count INTEGER NOT NULL DEFAULT 0
    CHECK (distinct_file_count >= 0),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('MEDIUM','HIGH','CRITICAL')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','REVIEWING','DISMISSED','CONFIRMED')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by TEXT REFERENCES inventory_user_profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logistics_file_access_alert_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  alert_id UUID NOT NULL REFERENCES logistics_file_access_alerts(id),
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  detail TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_file_access_alert_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los eventos de alertas de acceso son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_file_access_alert_events_no_change
  ON logistics_file_access_alert_events;
CREATE TRIGGER logistics_file_access_alert_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_file_access_alert_events
  FOR EACH ROW EXECUTE FUNCTION logistics_file_access_alert_events_immutable();

CREATE INDEX IF NOT EXISTS logistics_file_access_alerts_open_idx
  ON logistics_file_access_alerts
  (organization_id,status,risk_level,created_at DESC);
CREATE INDEX IF NOT EXISTS logistics_file_access_alerts_actor_idx
  ON logistics_file_access_alerts
  (actor_profile_id,window_started_at DESC);
CREATE INDEX IF NOT EXISTS logistics_file_access_alert_events_date_idx
  ON logistics_file_access_alert_events (alert_id,occurred_at);

ALTER TABLE logistics_file_access_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_file_access_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_file_access_alerts,
  logistics_file_access_alert_events FROM anon,authenticated;
