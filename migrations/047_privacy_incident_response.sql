-- Respuesta estructurada y auditable ante incidentes de datos personales.
CREATE TABLE IF NOT EXISTS logistics_privacy_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  incident_number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  owner_profile_id TEXT REFERENCES inventory_user_profiles(id),
  data_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject_categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  affected_count INTEGER CHECK (affected_count IS NULL OR affected_count >= 0),
  confidentiality_affected BOOLEAN NOT NULL DEFAULT TRUE,
  integrity_affected BOOLEAN NOT NULL DEFAULT FALSE,
  availability_affected BOOLEAN NOT NULL DEFAULT FALSE,
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  risk_score INTEGER NOT NULL DEFAULT 40 CHECK (risk_score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'DETECTED'
    CHECK (status IN ('DETECTED','ASSESSING','CONTAINED','NOTIFICATION_DECIDED','CLOSED')),
  containment_actions TEXT,
  notification_required BOOLEAN,
  notification_reason TEXT,
  authority_notified_at TIMESTAMPTZ,
  subjects_notified_at TIMESTAMPTZ,
  root_cause TEXT,
  corrective_actions TEXT,
  contained_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  updated_by TEXT REFERENCES inventory_user_profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id,incident_number)
);

CREATE TABLE IF NOT EXISTS logistics_privacy_incident_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES logistics_organizations(id),
  incident_id UUID NOT NULL REFERENCES logistics_privacy_incidents(id),
  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL REFERENCES inventory_user_profiles(id),
  detail TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION logistics_privacy_incident_events_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Los eventos de incidentes de privacidad son inalterables';
END $$;

DROP TRIGGER IF EXISTS logistics_privacy_incident_events_no_change
  ON logistics_privacy_incident_events;
CREATE TRIGGER logistics_privacy_incident_events_no_change
  BEFORE UPDATE OR DELETE ON logistics_privacy_incident_events
  FOR EACH ROW EXECUTE FUNCTION logistics_privacy_incident_events_immutable();

CREATE INDEX IF NOT EXISTS logistics_privacy_incidents_status_idx
  ON logistics_privacy_incidents (organization_id,status,severity,detected_at DESC);
CREATE INDEX IF NOT EXISTS logistics_privacy_incident_events_date_idx
  ON logistics_privacy_incident_events (incident_id,occurred_at);

ALTER TABLE logistics_privacy_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE logistics_privacy_incident_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON logistics_privacy_incidents,
  logistics_privacy_incident_events FROM anon,authenticated;
